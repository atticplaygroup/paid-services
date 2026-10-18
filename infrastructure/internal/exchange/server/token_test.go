package server

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
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

func TestBuyPointsRequiresSession(t *testing.T) {
	server := &Server{}
	_, err := server.BuyPoints(context.Background(), connect.NewRequest(&pb.BuyPointsRequest{}))
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
		TokenIssuer:            "https://exchange.example",
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
		claims.CoinType != 1 ||
		claims.CoinEnvironment != 4 ||
		claims.Audience[0] != "bafk-test-provider" ||
		claims.Issuer != "https://exchange.example" {
		t.Fatalf("unexpected claims: %+v", claims.RegisteredClaims)
	}
}

func TestGeneratedJwtMatchesHandleJWKS(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	server := &Server{config: &exchange.Config{
		TokenSigningPrivateKey: ed25519.NewKeyFromSeed(seed),
		TokenSigningKeyId:      "test-key",
		TokenIssuer:            "https://exchange.example",
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

func TestJWKSIncludesRetiredKeyForRotation(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	retired := make([]byte, ed25519.PublicKeySize)
	for i := range retired {
		retired[i] = byte(i)
	}
	retiredJSON, err := json.Marshal([]map[string]string{{
		"kid": "retired-key",
		"x":   base64.RawURLEncoding.EncodeToString(retired),
	}})
	if err != nil {
		t.Fatalf("marshal retired key: %v", err)
	}
	server := &Server{config: &exchange.Config{
		TokenSigningPrivateKey: ed25519.NewKeyFromSeed(seed),
		TokenSigningKeyId:      "active-key",
		TokenRetiredPublicKeys: string(retiredJSON),
	}}
	recorder := httptest.NewRecorder()
	server.HandleJWKS(recorder, httptest.NewRequest(http.MethodGet, "/.well-known/jwks.json", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var document struct {
		Keys []publicJWK `json:"keys"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("decode JWKS: %v", err)
	}
	if len(document.Keys) != 2 || document.Keys[0].Kid != "active-key" || document.Keys[1].Kid != "retired-key" {
		t.Fatalf("unexpected JWKS keys: %+v", document.Keys)
	}
}
