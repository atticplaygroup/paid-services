package account

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"

	"github.com/MicahParks/jwkset"
	"github.com/MicahParks/keyfunc/v3"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/golang-jwt/jwt/v5"
)

func newValidatorFixture(t *testing.T) (*jwtValidator, ed25519.PrivateKey, string) {
	t.Helper()
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
	jwks, err := storage.JSON(context.Background())
	if err != nil {
		t.Fatalf("marshal jwks: %v", err)
	}
	keyFunc, err := keyfunc.NewJWKSetJSON(jwks)
	if err != nil {
		t.Fatalf("create keyfunc: %v", err)
	}
	validator := &jwtValidator{
		audience:        []string{validAudience("bafkreigcp47gwekkttqujhtwtasbqjazquza4onx3pbd5du7upw2pic35e")},
		validExchanges:  []string{"http://test-exchange/.well-known/jwks.json"},
		validIssuers:    []string{"test-exchange"},
		coinType:        pb.CoinType(1),
		coinEnvironment: pb.CoinEnvironment(4),
		keyFunc:         keyFunc,
	}
	if validator.audience[0] == "" {
		t.Fatal("canonical audience fixture was rejected")
	}
	return validator, privateKey, keyID
}

func setupJwtValidatorFixture(t *testing.T, issuer string, tokenID string) (*jwtValidator, ed25519.PrivateKey) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyID := tokenID
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
	jwks, err := storage.JSON(context.Background())
	if err != nil {
		t.Fatalf("marshal jwks: %v", err)
	}
	keyFunc, err := keyfunc.NewJWKSetJSON(jwks)
	if err != nil {
		t.Fatalf("create keyfunc: %v", err)
	}
	validator := &jwtValidator{
		audience:        []string{validAudience("bafkreigcp47gwekkttqujhtwtasbqjazquza4onx3pbd5du7upw2pic35e")},
		validExchanges:  []string{"http://test-exchange/.well-known/jwks.json"},
		validIssuers:    []string{issuer},
		coinType:        pb.CoinType(1),
		coinEnvironment: pb.CoinEnvironment(4),
		keyFunc:         keyFunc,
	}
	return validator, privateKey
}

func signedExchangeTokenFromValidator(t *testing.T, privateKey ed25519.PrivateKey, validator *jwtValidator, quantity int64, tokenID string) string {
	t.Helper()
	if len(validator.audience) == 0 || len(validator.validIssuers) == 0 {
		t.Fatal("validator fixture is incomplete")
	}
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    validator.validIssuers[0],
			Audience:  jwt.ClaimStrings{validator.audience[0]},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        tokenID,
		},
		Quantity:        quantity,
		Usage:           pb.JwtUsage_JWT_USAGE_CREATE_SESSION,
		CoinType:        validator.coinType,
		CoinEnvironment: validator.coinEnvironment,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = tokenID
	signed, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func signedExchangeToken(t *testing.T, privateKey ed25519.PrivateKey, keyID string, audience string, usage pb.JwtUsage) string {
	t.Helper()
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    keyID,
			Audience:  jwt.ClaimStrings{audience},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        "token-id",
		},
		Quantity:        10,
		Usage:           pb.JwtUsage(usage),
		CoinType:        pb.CoinType(1),
		CoinEnvironment: pb.CoinEnvironment(4),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	token.Header["kid"] = keyID
	signed, err := token.SignedString(privateKey)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func TestValidateAcceptsProviderID(t *testing.T) {
	validator, privateKey, keyID := newValidatorFixture(t)
	for _, audience := range validator.audience {
		quantity, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, audience, pb.JwtUsage_JWT_USAGE_CREATE_SESSION))
		if err != nil {
			t.Fatalf("validate audience %q: %v", audience, err)
		}
		if quantity != 10 {
			t.Fatalf("quantity=%d want 10", quantity)
		}
	}
}

func TestValidateRejectsWrongAudienceUsageAndCoin(t *testing.T) {
	validator, privateKey, keyID := newValidatorFixture(t)
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, "bafk-test-provider", pb.JwtUsage_JWT_USAGE_CREATE_SESSION)); err == nil {
		t.Fatal("expected non-multiformat bafk audience to be rejected")
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, "http://wrong.example", pb.JwtUsage_JWT_USAGE_CREATE_SESSION)); err == nil {
		t.Fatal("expected wrong audience to be rejected")
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, validator.audience[0], pb.JwtUsage_JWT_USAGE_CREATE_SESSION)); err != nil {
		t.Fatalf("control token should validate: %v", err)
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, validator.audience[0], pb.JwtUsage_JWT_USAGE_MANAGE_SESSION)); err == nil {
		t.Fatal("expected wrong usage to be rejected")
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, validator.audience[0], pb.JwtUsage_JWT_USAGE_CREATE_SESSION)); err != nil {
		t.Fatalf("control token should validate: %v", err)
	}
}
