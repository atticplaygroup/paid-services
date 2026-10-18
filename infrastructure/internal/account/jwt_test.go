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

type noopRedeemer struct{}

func (noopRedeemer) Redeem(context.Context, string, time.Time) error { return nil }

func newValidatorFixture(t *testing.T) (*jwtValidator, ed25519.PrivateKey, string) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyID := "test-key"
	issuer := "https://test-exchange.example"
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
		audience:        []string{validAudience("bahi5maysedbh6ptlcffjzyketz3jqjayeqmykmqohg35xqr6r2p2h3nhubn6s")},
		issuers:         map[string]keyfunc.Keyfunc{issuer: keyFunc},
		coinType:        pb.CoinType(1),
		coinEnvironment: pb.CoinEnvironment(4),
		redeemer:        noopRedeemer{},
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
		audience:        []string{validAudience("bahi5maysedbh6ptlcffjzyketz3jqjayeqmykmqohg35xqr6r2p2h3nhubn6s")},
		issuers:         map[string]keyfunc.Keyfunc{issuer: keyFunc},
		coinType:        pb.CoinType(1),
		coinEnvironment: pb.CoinEnvironment(4),
		redeemer:        noopRedeemer{},
	}
	return validator, privateKey
}

func signedExchangeTokenFromValidator(t *testing.T, privateKey ed25519.PrivateKey, validator *jwtValidator, quantity int64, tokenID string) string {
	t.Helper()
	if len(validator.audience) == 0 || len(validator.issuers) == 0 {
		t.Fatal("validator fixture is incomplete")
	}
	var issuer string
	for issuer = range validator.issuers {
		break
	}
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    issuer,
			Audience:  jwt.ClaimStrings{validator.audience[0]},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        tokenID,
		},
		Quantity:        quantity,
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

func signedExchangeToken(t *testing.T, privateKey ed25519.PrivateKey, keyID string, audience string) string {
	return signedExchangeTokenWithIssuer(t, privateKey, "https://test-exchange.example", keyID, audience)
}

func signedExchangeTokenWithIssuer(t *testing.T, privateKey ed25519.PrivateKey, issuer string, keyID string, audience string) string {
	t.Helper()
	claims := &DepositJwtClaims{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    issuer,
			Audience:  jwt.ClaimStrings{audience},
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
			ID:        "token-id",
		},
		Quantity:        10,
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

func TestValidateBindsKeysToIssuer(t *testing.T) {
	validator, privateKeyA, keyID := newValidatorFixture(t)
	const issuerB = "https://other-exchange.example"
	validatorB, _ := setupJwtValidatorFixture(t, issuerB, keyID)
	validator.issuers[issuerB] = validatorB.issuers[issuerB]

	token := signedExchangeTokenWithIssuer(
		t, privateKeyA, issuerB, keyID, validator.audience[0],
	)
	if _, err := validator.validate(context.Background(), token); err == nil {
		t.Fatal("expected a key belonging to another trusted issuer to be rejected")
	}
}

func TestValidateAcceptsProviderID(t *testing.T) {
	validator, privateKey, keyID := newValidatorFixture(t)
	for _, audience := range validator.audience {
		quantity, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, audience))
		if err != nil {
			t.Fatalf("validate audience %q: %v", audience, err)
		}
		if quantity != 10 {
			t.Fatalf("quantity=%d want 10", quantity)
		}
	}
}

func TestValidateRejectsWrongAudience(t *testing.T) {
	validator, privateKey, keyID := newValidatorFixture(t)
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, "bafk-test-provider")); err == nil {
		t.Fatal("expected non-multiformat bafk audience to be rejected")
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, "http://wrong.example")); err == nil {
		t.Fatal("expected wrong audience to be rejected")
	}
	if _, err := validator.validate(context.Background(), signedExchangeToken(t, privateKey, keyID, validator.audience[0])); err != nil {
		t.Fatalf("control token should validate: %v", err)
	}
}
