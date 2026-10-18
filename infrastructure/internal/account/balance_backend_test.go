package account

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	epb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/golang-jwt/jwt/v5"

	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/migrations"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	testpostgres "github.com/atticplaygroup/paid-services/infrastructure/testing"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/lib/pq"
	migrate "github.com/rubenv/sql-migrate"
)

func (s *Server) TestGetBalanceWithPrincipal(
	ctx context.Context,
	principal string,
) (*connect.Response[pb.GetBalanceResponse], error) {
	balance, err := s.balanceStore.Get(ctx, principal)
	if err != nil {
		if errors.Is(err, balancepkg.ErrNotFound) {
			return nil, status.Errorf(codes.PermissionDenied, "account not found: %v", err)
		}
		return nil, status.Errorf(codes.Internal, "fetch balance: %v", err)
	}
	return connect.NewResponse(&pb.GetBalanceResponse{Balance: balance}), nil
}

func (s *Server) TestDepositOrCreateAccountWithPrincipal(
	ctx context.Context,
	principal string,
	jwt string,
) (*connect.Response[pb.DepositOrCreateAccountResponse], error) {
	quantity, err := s.jwtValidator.validate(ctx, jwt)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "exchange token validation: %v", err)
	}
	balanceValue, err := s.balanceStore.Increment(ctx, principal, quantity)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "increase balance: %v", err)
	}
	return connect.NewResponse(&pb.DepositOrCreateAccountResponse{
		Account: &pb.Account{AccountId: principal, Balance: balanceValue},
	}), nil
}

func setupBalanceBackendTest(t *testing.T) (*Server, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	srv := &Server{
		redisClient:  rdb,
		balanceStore: balancepkg.NewRedisStore(rdb),
		jwtRedeemer:  NewRedisRedeemer(rdb),
	}
	return srv, mr
}

func TestGetBalanceReturnsConfiguredPositiveBalance(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	key := utils.AuthzKey(principal)
	if err := mr.Set(key, "12345"); err != nil {
		t.Fatalf("seed balance: %v", err)
	}

	resp, err := srv.TestGetBalanceWithPrincipal(context.Background(), principal)
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if resp.Msg.GetBalance() != 12345 {
		t.Fatalf("balance=%d want 12345", resp.Msg.GetBalance())
	}
}

func TestGetBalanceRejectsUnknownAccount(t *testing.T) {
	srv, _ := setupBalanceBackendTest(t)
	_, err := srv.TestGetBalanceWithPrincipal(context.Background(), "unknown")
	if err == nil {
		t.Fatal("expected unknown account to be rejected")
	}
	if err == nil || !strings.Contains(err.Error(), "balance not found") {
		t.Fatalf("error=%v want redis nil error", err)
	}
}

func TestDepositOrCreateAccountRejectsEmptyJwt(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"

	resp, err := srv.TestDepositOrCreateAccountWithPrincipal(
		context.Background(), principal, "",
	)
	if err == nil {
		t.Fatal("expected empty jwt to be rejected")
	}
	if resp != nil {
		t.Fatalf("unexpected response on invalid jwt: %v", resp)
	}
	if err == nil || !strings.Contains(err.Error(), "exchange token validation: empty jwt") {
		t.Fatalf("error=%v want empty jwt error", err)
	}
	if _, err := mr.Get(utils.AuthzKey(principal)); err == nil {
		t.Fatal("expected no balance to be created for invalid jwt")
	}
}

func TestDepositOrCreateAccountRejectsUnsignedJwt(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"

	resp, err := srv.TestDepositOrCreateAccountWithPrincipal(
		context.Background(), principal, "invalid-jwt",
	)
	if err == nil {
		t.Fatal("expected unsigned jwt to be rejected")
	}
	if resp != nil {
		t.Fatalf("unexpected response on invalid jwt: %v", resp)
	}
	if err == nil || !strings.Contains(err.Error(), "exchange token validation:") {
		t.Fatalf("error=%v want exchange token validation error", err)
	}
	if _, err := mr.Get(utils.AuthzKey(principal)); err == nil {
		t.Fatal("expected no balance to be created for invalid jwt")
	}
}

func TestDepositOrCreateAccountRejectsReplayedJwt(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	tokenID := "jwt-id"
	expiresAt := time.Now().Add(time.Hour).UTC()

	if err := srv.jwtRedeemer.Redeem(
		context.Background(), tokenID, expiresAt,
	); err != nil {
		t.Fatalf("consume token: %v", err)
	}

	quantity, err := srv.jwtValidator.validate(context.Background(), "not-a-jwt")
	if err == nil || quantity > 0 {
		t.Fatal("invalid fixture should not validate as a signed jwt")
	}
	if err == nil || !strings.Contains(err.Error(), "JWT validation not configured") {
		t.Fatalf("error=%v want missing JWT configuration error", err)
	}
	if _, err := mr.Get(utils.AuthzKey(principal)); err == nil {
		t.Fatal("expected no balance to be created for invalid jwt")
	}
}

func TestDepositOrCreateAccountAcceptsValidJwt(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyID := "test-exchange"
	storage := jwkset.NewMemoryStorage()
	key, err := jwkset.NewJWKFromKey(publicKey, jwkset.JWKOptions{
		Metadata: jwkset.JWKMetadataOptions{
			ALG: jwkset.AlgEdDSA,
			KID: keyID,
			USE: jwkset.UseSig,
		},
	})
	if err != nil {
		t.Fatalf("create jwk: %v", err)
	}
	if err := storage.KeyWrite(context.Background(), key); err != nil {
		t.Fatalf("write jwk: %v", err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		document, err := storage.JSON(context.Background())
		if err != nil {
			t.Errorf("marshal jwks: %v", err)
			http.Error(w, "jwks error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(jwksServer.Close)

	keyFunc, err := keyfunc.NewDefault([]string{jwksServer.URL})
	if err != nil {
		t.Fatalf("initialize keyfunc: %v", err)
	}
	srv.jwtValidator = &jwtValidator{
		audience:        []string{validAudience("bahi5maysedbh6ptlcffjzyketz3jqjayeqmykmqohg35xqr6r2p2h3nhubn6s")},
		issuers:         map[string]keyfunc.Keyfunc{"https://trusted.example": keyFunc},
		coinType:        epb.CoinType(1),
		coinEnvironment: epb.CoinEnvironment(4),
		redeemer:        srv.jwtRedeemer,
	}
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    "https://trusted.example",
			Audience:  jwt.ClaimStrings{srv.jwtValidator.audience[0]},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        "valid-token-id",
		},
		Quantity:        123,
		CoinType:        epb.CoinType(1),
		CoinEnvironment: epb.CoinEnvironment(4),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = keyID
	signedToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	resp, err := srv.TestDepositOrCreateAccountWithPrincipal(context.Background(), principal, signedToken)
	if err != nil {
		t.Fatalf("DepositOrCreateAccount: %v", err)
	}
	if resp.Msg.GetAccount().GetBalance() != 123 {
		t.Fatalf("balance=%d want 123", resp.Msg.GetAccount().GetBalance())
	}
	balance, err := srv.TestGetBalanceWithPrincipal(context.Background(), principal)
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if balance.Msg.GetBalance() != 123 {
		t.Fatalf("stored balance=%d want 123", balance.Msg.GetBalance())
	}
	if got, err := mr.Get(utils.AuthzKey(principal)); err != nil || got != "123" {
		t.Fatalf("redis value=%q err=%v want 123", got, err)
	}
}

func TestDepositOrCreateAccountRejectsUnknownExchangeJwt(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyID := "unknown-exchange"
	storage := jwkset.NewMemoryStorage()
	key, err := jwkset.NewJWKFromKey(publicKey, jwkset.JWKOptions{
		Metadata: jwkset.JWKMetadataOptions{
			ALG: jwkset.AlgEdDSA,
			KID: keyID,
			USE: jwkset.UseSig,
		},
	})
	if err != nil {
		t.Fatalf("create jwk: %v", err)
	}
	if err := storage.KeyWrite(context.Background(), key); err != nil {
		t.Fatalf("write jwk: %v", err)
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		document, err := storage.JSON(context.Background())
		if err != nil {
			http.Error(w, "jwks error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(jwksServer.Close)

	keyFunc, err := keyfunc.NewDefault([]string{jwksServer.URL})
	if err != nil {
		t.Fatalf("initialize keyfunc: %v", err)
	}
	srv.jwtValidator = &jwtValidator{
		audience:        []string{validAudience("bahi5maysedbh6ptlcffjzyketz3jqjayeqmykmqohg35xqr6r2p2h3nhubn6s")},
		issuers:         map[string]keyfunc.Keyfunc{"https://trusted.example": keyFunc},
		coinType:        epb.CoinType(1),
		coinEnvironment: epb.CoinEnvironment(4),
		redeemer:        srv.jwtRedeemer,
	}
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    "https://untrusted.example",
			Audience:  jwt.ClaimStrings{srv.jwtValidator.audience[0]},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        "unknown-exchange-token",
		},
		Quantity:        123,
		CoinType:        epb.CoinType(1),
		CoinEnvironment: epb.CoinEnvironment(4),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = keyID
	signedToken, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}

	if _, err := srv.TestDepositOrCreateAccountWithPrincipal(context.Background(), principal, signedToken); err == nil {
		t.Fatal("expected unknown exchange token to be rejected")
	}
	if _, err := mr.Get(utils.AuthzKey(principal)); err == nil {
		t.Fatal("expected no balance to be created for unknown exchange token")
	}
}

func TestDepositOrCreateAccountUsesPostgresBackend(t *testing.T) {
	databaseURL := testpostgres.StartPostgres(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)

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

	balanceStore, err := balancepkg.NewPostgresStore(context.Background(), databaseURL)
	if err != nil {
		t.Skipf("database is unavailable: %v", err)
	}
	t.Cleanup(balanceStore.Close)

	srv, _ := setupBalanceBackendTest(t)
	srv.balanceStore = balanceStore
	validator, privateKey := setupJwtValidatorFixture(t, "https://trusted.example", "valid-pg-token")
	srv.jwtValidator = validator
	quantity := int64(321)
	token := signedExchangeTokenFromValidator(t, privateKey, validator, quantity, "valid-pg-token")

	resp, err := srv.TestDepositOrCreateAccountWithPrincipal(context.Background(), "postgres-account", token)
	if err != nil {
		t.Fatalf("DepositOrCreateAccount: %v", err)
	}
	if resp.Msg.GetAccount().GetBalance() != quantity {
		t.Fatalf("balance=%d want %d", resp.Msg.GetAccount().GetBalance(), quantity)
	}
	balance, err := srv.TestGetBalanceWithPrincipal(context.Background(), "postgres-account")
	if err != nil {
		t.Fatalf("GetBalance: %v", err)
	}
	if balance.Msg.GetBalance() != quantity {
		t.Fatalf("stored balance=%d want %d", balance.Msg.GetBalance(), quantity)
	}
	var stored int64
	if err := pool.QueryRow(context.Background(), `SELECT balance FROM accounts WHERE principal = $1`, "postgres-account").Scan(&stored); err != nil {
		t.Fatalf("query fixture: %v", err)
	}
	if stored != quantity {
		t.Fatalf("database balance=%d want %d", stored, quantity)
	}
	if _, err := pool.Exec(context.Background(), `DELETE FROM accounts WHERE principal = $1`, "postgres-account"); err != nil {
		t.Fatalf("cleanup fixture: %v", err)
	}
}
