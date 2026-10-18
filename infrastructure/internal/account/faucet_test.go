package account

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"buf.build/go/protovalidate"
	"connectrpc.com/connect"
	"github.com/alicebob/miniredis/v2"
	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/redis/go-redis/v9"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

func setupFaucetTest(t *testing.T) (*Server, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	validator, err := protovalidate.New()
	if err != nil {
		t.Fatalf("protovalidate: %v", err)
	}

	srv := &Server{
		redisClient:    rdb,
		balanceStore:   balancepkg.NewRedisStore(rdb),
		ProtoValidator: validator,
	}
	return srv, mr
}

func TestFaucetDisabled(t *testing.T) {
	srv, _ := setupFaucetTest(t)

	req := &pb.CreditBalanceRequest{
		Amount: 1000,
	}

	_, err := srv.CreditBalance(middleware.WithSession(context.Background(), &middleware.Session{UserId: "testuser", RequestId: "req"}), connect.NewRequest(req))
	if err == nil {
		t.Fatal("expected error when faucet is disabled")
	}
	msg := err.Error()
	if !strings.Contains(msg, "faucet is not enabled") {
		t.Fatalf("expected 'faucet is not enabled' error, got: %s", msg)
	}
}

func TestFaucetCreditBalance(t *testing.T) {
	srv, mr := setupFaucetTest(t)
	EnableFaucet()
	defer atomic.StoreInt32(&faucetEnabled, 0)

	req := &pb.CreditBalanceRequest{
		Amount: 5000,
	}

	resp, err := srv.CreditBalance(middleware.WithSession(context.Background(), &middleware.Session{UserId: "alice", RequestId: "req"}), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("CreditBalance: %v", err)
	}

	acct := resp.Msg.GetAccount()
	if acct.GetAccountId() != "alice" {
		t.Fatalf("account_id=%q want %q", acct.GetAccountId(), "alice")
	}
	if acct.GetBalance() != 5000 {
		t.Fatalf("balance=%d want %d", acct.GetBalance(), 5000)
	}
	if acct.GetExpireTime() == nil {
		t.Fatal("expire_time is nil")
	}

	// Verify Redis directly
	key := utils.AuthzKey("alice")
	val, err := mr.Get(key)
	if err != nil {
		t.Fatalf("redis get: %v", err)
	}
	if val != "5000" {
		t.Fatalf("redis balance=%q want %q", val, "5000")
	}
}

func TestFaucetAccumulates(t *testing.T) {
	srv, mr := setupFaucetTest(t)
	EnableFaucet()
	defer atomic.StoreInt32(&faucetEnabled, 0)

	ctx := middleware.WithSession(context.Background(), &middleware.Session{UserId: "bob", RequestId: "req"})
	req1 := &pb.CreditBalanceRequest{Amount: 100}
	_, err := srv.CreditBalance(ctx, connect.NewRequest(req1))
	if err != nil {
		t.Fatalf("first credit: %v", err)
	}

	req2 := &pb.CreditBalanceRequest{Amount: 200}
	resp2, err := srv.CreditBalance(ctx, connect.NewRequest(req2))
	if err != nil {
		t.Fatalf("second credit: %v", err)
	}
	if resp2.Msg.GetAccount().GetBalance() != 300 {
		t.Fatalf("accumulated balance=%d want 300", resp2.Msg.GetAccount().GetBalance())
	}

	val, err := mr.Get(utils.AuthzKey("bob"))
	if err != nil {
		t.Fatalf("redis get: %v", err)
	}
	if val != "300" {
		t.Fatalf("redis balance=%q want %q", val, "300")
	}
}

func TestFaucetSetsTtl(t *testing.T) {
	srv, mr := setupFaucetTest(t)
	EnableFaucet()
	defer atomic.StoreInt32(&faucetEnabled, 0)

	req := &pb.CreditBalanceRequest{Amount: 100}
	_, err := srv.CreditBalance(middleware.WithSession(context.Background(), &middleware.Session{UserId: "charlie", RequestId: "req"}), connect.NewRequest(req))
	if err != nil {
		t.Fatalf("CreditBalance: %v", err)
	}

	ttl := mr.TTL(utils.AuthzKey("charlie"))
	if ttl <= 0 {
		t.Fatalf("expected positive TTL, got %v", ttl)
	}
}

func TestFaucetRequiresSession(t *testing.T) {
	srv, _ := setupFaucetTest(t)
	EnableFaucet()
	defer atomic.StoreInt32(&faucetEnabled, 0)

	_, err := srv.CreditBalance(context.Background(), connect.NewRequest(&pb.CreditBalanceRequest{Amount: 100}))
	if err == nil {
		t.Fatal("expected error without session")
	}
	if !strings.Contains(err.Error(), "invalid session") {
		t.Fatalf("expected invalid session, got: %v", err)
	}
}
