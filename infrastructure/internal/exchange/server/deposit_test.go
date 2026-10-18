package server

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/migrations"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	testpostgres "github.com/atticplaygroup/paid-services/infrastructure/testing"
	"github.com/block-vision/sui-go-sdk/signer"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/lib/pq"
	migrate "github.com/rubenv/sql-migrate"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type fakeClock struct {
	now time.Time
}

func (clock fakeClock) Now() time.Time {
	return clock.now
}

type fakePaymentClient struct {
	info *exchange.DepositTransferInfo
	err  error
}

func (client *fakePaymentClient) CheckTransactionStatus(context.Context, string) (exchange.TransactionStatus, error) {
	return exchange.SUCCESS, nil
}

func (client *fakePaymentClient) PrepareWithdrawTransaction(context.Context, []exchange.TransferInfo, uint64) (*exchange.WithdrawInformation, error) {
	return nil, fmt.Errorf("not implemented")
}

func (client *fakePaymentClient) Withdraw(context.Context, *exchange.WithdrawInformation) (string, error) {
	return "", fmt.Errorf("not implemented")
}

func (client *fakePaymentClient) CheckDeposit(context.Context, string, int) (*exchange.DepositTransferInfo, error) {
	return client.info, client.err
}

func TestDepositRejectsInvalidTtl(t *testing.T) {
	server := &Server{config: &exchange.Config{MaxExpirationExtension: 100}}
	_, err := server.Deposit(context.Background(), connect.NewRequest(&pb.DepositRequest{
		Ttl: durationpb.New(101 * time.Second),
	}))
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status=%v want InvalidArgument", status.Code(err))
	}
}

func TestGetChallengeAndVerifyThroughHandler(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	auth := &exchange.Auth{
		Secret:             ed25519.NewKeyFromSeed(seed),
		MessageAuthTimeout: time.Minute,
		Clock:              fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	server := &Server{auth: *auth}
	response, err := server.GetChallenge(context.Background(), connect.NewRequest(&pb.GetChallengeRequest{
		Address: "0x1111111111111111111111111111111111111111111111111111111111111111",
	}))
	if err != nil {
		t.Fatalf("GetChallenge: %v", err)
	}
	if err := server.auth.VerifySuiAuthMessagePayload(&exchange.SuiAuthMessage{
		StartTime: response.Msg.GetStartTime().AsTime(),
		Challenge: response.Msg.GetChallenge(),
		Address:   "0x1111111111111111111111111111111111111111111111111111111111111111",
	}); err != nil {
		t.Fatalf("verify challenge: %v", err)
	}
}

func TestDepositRejectsNonPositiveAmount(t *testing.T) {
	server := &Server{
		config:        &exchange.Config{MaxExpirationExtension: 1000},
		paymentClient: &fakePaymentClient{info: &exchange.DepositTransferInfo{TransferInfo: &exchange.TransferInfo{Amount: 0, Address: "0x1111111111111111111111111111111111111111111111111111111111111111"}, Epoch: 2}},
	}
	_, err := server.Deposit(context.Background(), connect.NewRequest(&pb.DepositRequest{
		Ttl: durationpb.New(time.Second),
		Proof: &pb.SuiDepositProof{
			ChainDigest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhpJ",
		},
	}))
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("status=%v want InvalidArgument", status.Code(err))
	}
}

func TestDepositRejectsShortChainAddress(t *testing.T) {
	server := &Server{
		config:        &exchange.Config{MaxExpirationExtension: 1000},
		paymentClient: &fakePaymentClient{info: &exchange.DepositTransferInfo{TransferInfo: &exchange.TransferInfo{Amount: 100, Address: "0x1"}, Epoch: 2}},
	}
	_, err := server.Deposit(context.Background(), connect.NewRequest(&pb.DepositRequest{
		Ttl: durationpb.New(time.Second),
		Proof: &pb.SuiDepositProof{
			ChainDigest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhpJ",
		},
	}))
	if status.Code(err) != codes.Internal {
		t.Fatalf("status=%v want Internal", status.Code(err))
	}
}

func TestDepositRejectsInvalidSignature(t *testing.T) {
	server := &Server{
		config: &exchange.Config{MaxExpirationExtension: 1000, AccountTtlPrice: 0.1},
		paymentClient: &fakePaymentClient{info: &exchange.DepositTransferInfo{
			TransferInfo: &exchange.TransferInfo{Amount: 100, Address: "0x1111111111111111111111111111111111111111111111111111111111111111"},
			Epoch:        2,
		}},
	}
	_, err := server.Deposit(context.Background(), connect.NewRequest(&pb.DepositRequest{
		Ttl: durationpb.New(time.Second),
		Proof: &pb.SuiDepositProof{
			ChainDigest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhpJ",
			Signature:   "invalid-signature",
		},
	}))
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("status=%v want PermissionDenied", status.Code(err))
	}
}

func setupExchangeStore(t *testing.T) *store.Store {
	t.Helper()
	databaseURL := testpostgres.StartPostgres(t)
	testDb, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = testDb.Close() })
	if _, err := migrate.Exec(testDb, "postgres", migrations.Source{}, migrate.Down); err != nil {
		t.Logf("migrate down: %v", err)
	}
	if _, err := testDb.Exec(`DROP TABLE IF EXISTS
		used_exchange_tokens,
		withdrawals,
		processing_withdrawals,
		deposits,
		accounts CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := migrate.Exec(testDb, "postgres", migrations.Source{}, migrate.Up); err != nil {
		t.Fatalf("migrate up: %v", err)
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)
	return store.NewStore(pool)
}

func TestDepositStoresSignedChallenge(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	authSecret := make([]byte, ed25519.SeedSize)
	auth := &exchange.Auth{
		Secret:             ed25519.NewKeyFromSeed(authSecret),
		MessageAuthTimeout: time.Minute,
		Clock:              fakeClock{now: now},
	}
	wallet := signer.NewSigner(authSecret)
	storeInstance := setupExchangeStore(t)
	server := &Server{
		config: &exchange.Config{MaxExpirationExtension: 1000, AccountTtlPrice: 0.1},
		auth:   *auth,
		paymentClient: &fakePaymentClient{info: &exchange.DepositTransferInfo{
			TransferInfo: &exchange.TransferInfo{
				Amount:  100,
				Address: wallet.Address,
			},
			Epoch: 2,
		}},
		store: storeInstance,
	}

	challenge, err := auth.GetChallenge(wallet.Address, now)
	if err != nil {
		t.Fatalf("GetChallenge: %v", err)
	}
	signed, err := wallet.SignPersonalMessageV1(string(challenge[:]))
	if err != nil {
		t.Fatalf("SignPersonalMessageV1: %v", err)
	}
	response, err := server.Deposit(middleware.WithSession(context.Background(), &middleware.Session{
		UserId:    "deposit-user",
		RequestId: "deposit-request",
	}), connect.NewRequest(&pb.DepositRequest{
		Ttl: durationpb.New(time.Second),
		Proof: &pb.SuiDepositProof{
			ChainDigest: "DdzbG47u5MDUrSVArmVYmvnpDvspgKeAXxzgq2cNnhpJ",
			Challenge:   challenge[:],
			StartTime:   timestamppb.New(now),
			Signature:   signed.Signature,
		},
	}))
	if err != nil {
		t.Fatalf("Deposit: %v", err)
	}
	account := response.Msg.GetAccount()
	if account.GetPrincipal() != "deposit-user" {
		t.Fatalf("principal=%q want deposit-user", account.GetPrincipal())
	}
	if account.GetBalance() != 99 {
		t.Fatalf("balance=%d want 99", account.GetBalance())
	}
	var storedTTLSeconds float64
	if err := storeInstance.GetConn().QueryRow(context.Background(),
		"SELECT EXTRACT(EPOCH FROM expire_time - create_time) FROM accounts WHERE principal = $1",
		"deposit-user").Scan(&storedTTLSeconds); err != nil {
		t.Fatalf("query account lifetime: %v", err)
	}
	if storedTTLSeconds != 1 {
		t.Fatalf("stored account lifetime=%g seconds want 1", storedTTLSeconds)
	}
}
