package authzhttp

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
)

func setupAuthzServer(t *testing.T) (*Server, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	srv, err := New(Config{
		RedisAddress:   mr.Addr(),
		BalanceBackend: "redis",
		AllowZeroBalanceHTUs: []string{
			"/account.v1.AccountService/CreditBalance",
			"/account.v1.AccountService/DepositOrCreateAccount",
		},
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	return srv, mr
}

func testDPoPRequest(
	t *testing.T,
	mr *miniredis.Miniredis,
	priv *ecdsa.PrivateKey,
	method, scheme, host, path string,
	balance int,
) *authv3.CheckRequest {
	t.Helper()
	htu, err := dpop.HTU(scheme, host, path)
	if err != nil {
		t.Fatalf("build htu: %v", err)
	}
	proof, _, err := dpop.Mint(priv, method, htu)
	if err != nil {
		t.Fatalf("mint proof: %v", err)
	}
	res, err := dpop.NewVerifier(time.Minute).VerifyBearer("Bearer "+proof, method, htu)
	if err != nil {
		t.Fatalf("verify proof: %v", err)
	}
	principal, err := utils.DigestToMultihash(res.JKTBytes)
	if err != nil {
		t.Fatalf("principal: %v", err)
	}
	if balance >= 0 {
		if err := mr.Set(utils.AuthzKey(principal.String()), strconv.Itoa(balance)); err != nil {
			t.Fatalf("seed balance: %v", err)
		}
	}
	return &authv3.CheckRequest{
		Attributes: &authv3.AttributeContext{
			Request: &authv3.AttributeContext_Request{
				Http: &authv3.AttributeContext_HttpRequest{
					Method: method,
					Scheme: scheme,
					Host:   host,
					Path:   path,
					Headers: map[string]string{
						"authorization": "Bearer " + proof,
						":authority":    host,
					},
				},
			},
		},
	}
}

func testKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return key
}

func TestCheckAllowsPositiveRedisBalance(t *testing.T) {
	srv, mr := setupAuthzServer(t)
	req := testDPoPRequest(t, mr, testKey(t), "POST", "http", "provider.example:8080", pb.AccountService_GetBalance_FullMethodName, 12345)
	res, err := srv.check(context.Background(), req)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if res.GetStatus().GetCode() != 0 {
		t.Fatalf("unexpected denial: %s", res.GetStatus().GetMessage())
	}
}

func TestCheckDeniesZeroBalanceOutsideAllowList(t *testing.T) {
	srv, mr := setupAuthzServer(t)
	req := testDPoPRequest(t, mr, testKey(t), "POST", "http", "provider.example:8080", pb.AccountService_GetBalance_FullMethodName, 0)
	res, err := srv.check(context.Background(), req)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if res.GetStatus().GetCode() != 7 {
		t.Fatalf("expected permission denied, got %d: %s", res.GetStatus().GetCode(), res.GetStatus().GetMessage())
	}
}

func TestCheckAllowsDepositOrCreateAccountAtZeroBalance(t *testing.T) {
	srv, mr := setupAuthzServer(t)
	req := testDPoPRequest(t, mr, testKey(t), "POST", "http", "provider.example:8080", pb.AccountService_DepositOrCreateAccount_FullMethodName, -1)
	res, err := srv.check(context.Background(), req)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if res.GetStatus().GetCode() != 0 {
		t.Fatalf("unexpected denial: %s", res.GetStatus().GetMessage())
	}
}
