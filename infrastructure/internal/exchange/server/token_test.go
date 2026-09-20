package server

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/golang-jwt/jwt/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestBuyTokenRequiresSession(t *testing.T) {
	server := &Server{}
	_, err := server.BuyToken(context.Background(), connect.NewRequest(&pb.BuyTokenRequest{}))
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("status=%v want Unauthenticated", status.Code(err))
	}
}

func TestGenerateJwtClaims(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index)
	}
	server := &Server{config: &exchange.Config{
		TokenSigningPrivateKey: ed25519.NewKeyFromSeed(seed),
		TokenSigningKeyId:      "test-key",
		TokenTtl:               time.Minute,
		TokenCoinType:          1,
		TokenCoinEnvironment:   4,
	}}

	token, err := server.generateJwt("bafk-test-provider", 42)
	if err != nil {
		t.Fatalf("generateJwt: %v", err)
	}
	parsed, err := jwt.ParseWithClaims(token, &Token{}, func(*jwt.Token) (any, error) {
		return server.config.TokenSigningPrivateKey.Public(), nil
	}, jwt.WithValidMethods([]string{"EdDSA"}), jwt.WithExpirationRequired())
	if err != nil {
		t.Fatalf("parse jwt: %v", err)
	}
	claims, ok := parsed.Claims.(*Token)
	if !ok || !parsed.Valid {
		t.Fatal("invalid claims")
	}
	if claims.Quantity != 42 ||
		claims.Usage != pb.JwtUsage_JWT_USAGE_CREATE_SESSION ||
		claims.CoinType != 1 ||
		claims.CoinEnvironment != 4 ||
		claims.Audience[0] != "bafk-test-provider" ||
		claims.Issuer != "test-key" {
		t.Fatalf("unexpected claims: %+v", claims.RegisteredClaims)
	}
}

func TestGeneratedJwtMatchesHandleJWKS(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	server := &Server{config: &exchange.Config{
		TokenSigningPrivateKey: ed25519.NewKeyFromSeed(seed),
		TokenSigningKeyId:      "test-key",
		TokenTtl:               time.Minute,
		TokenCoinType:          1,
		TokenCoinEnvironment:   4,
	}}
	jwksServer := httptest.NewServer(http.HandlerFunc(server.HandleJWKS))
	t.Cleanup(jwksServer.Close)
	keyFunc, err := keyfunc.NewDefault([]string{jwksServer.URL})
	if err != nil {
		t.Fatalf("initialize keyfunc: %v", err)
	}

	token, err := server.generateJwt("bafk-test-provider", 42)
	if err != nil {
		t.Fatalf("generateJwt: %v", err)
	}
	claims := &Token{}
	parsed, err := jwt.ParseWithClaims(token, claims, keyFunc.Keyfunc, jwt.WithValidMethods([]string{"EdDSA"}))
	if err != nil {
		t.Fatalf("parse exchange jwt with account keyfunc: %v", err)
	}
	if !parsed.Valid || claims.Quantity != 42 {
		t.Fatalf("invalid parsed claims: valid=%v quantity=%d", parsed.Valid, claims.Quantity)
	}
	_ = jwkset.NewMemoryStorage
}
