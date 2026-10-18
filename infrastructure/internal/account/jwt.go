package account

import (
	"context"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/golang-jwt/jwt/v5"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
	"github.com/redis/go-redis/v9"
)

type jwtValidator struct {
	audience        []string
	issuers         map[string]keyfunc.Keyfunc
	coinType        pb.CoinType
	coinEnvironment pb.CoinEnvironment
	redeemer        Redeemer
}

type Redeemer interface {
	Redeem(ctx context.Context, tokenID string, expiresAt time.Time) error
}

type RedisRedeemer struct {
	client redis.UniversalClient
}

func NewRedisRedeemer(client redis.UniversalClient) *RedisRedeemer {
	return &RedisRedeemer{client: client}
}

func (r *RedisRedeemer) Redeem(ctx context.Context, tokenID string, expiresAt time.Time) error {
	if tokenID == "" {
		return fmt.Errorf("missing jwt id")
	}
	ttl := time.Until(expiresAt)
	if expiresAt.IsZero() {
		ttl = time.Hour
	} else if ttl <= 0 {
		return fmt.Errorf("jwt is expired")
	}
	ok, err := r.client.SetNX(ctx, "used-token:"+tokenID, "1", ttl).Result()
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("jwt has already been used")
	}
	return nil
}

func newJwtValidator(conf *Config, redeemer Redeemer) (*jwtValidator, error) {
	if redeemer == nil {
		return nil, fmt.Errorf("JWT redeemer is required")
	}
	issuers := make(map[string]keyfunc.Keyfunc, len(conf.TrustedIssuers))
	for _, trusted := range conf.TrustedIssuers {
		if err := trusted.Validate(); err != nil {
			return nil, fmt.Errorf("trusted issuer: %w", err)
		}
		if _, exists := issuers[trusted.Issuer]; exists {
			return nil, fmt.Errorf("duplicate trusted issuer %q", trusted.Issuer)
		}
		kf, err := keyfunc.NewDefaultCtx(context.Background(), []string{trusted.JWKSURL})
		if err != nil {
			return nil, fmt.Errorf("initialize JWKS for issuer %q: %w", trusted.Issuer, err)
		}
		issuers[trusted.Issuer] = kf
	}
	return &jwtValidator{
		audience:        []string{validAudience(conf.ValidAudience)},
		issuers:         issuers,
		coinType:        pb.CoinType(conf.ValidCoinType),
		coinEnvironment: pb.CoinEnvironment(conf.ValidCoinEnvironment),
		redeemer:        redeemer,
	}, nil
}

func validAudience(value string) string {
	principal, err := cid.Decode(value)
	if err != nil || principal.Version() != 1 || principal.Type() != utils.JWKJCSPublicKeyCodec || principal.String() != value {
		return ""
	}
	digest, err := mh.Decode(principal.Hash())
	if err != nil || digest.Code != mh.SHA2_256 || len(digest.Digest) != 32 {
		return ""
	}
	return value
}

type DepositJwtClaims struct {
	*jwt.RegisteredClaims
	Quantity        int64              `json:"quantity"`
	CoinType        pb.CoinType        `json:"coin"`
	CoinEnvironment pb.CoinEnvironment `json:"env"`
}

func (v *jwtValidator) validate(ctx context.Context, token string) (int64, error) {
	if token == "" {
		return -1, fmt.Errorf("empty jwt")
	}
	if v == nil || len(v.issuers) == 0 {
		return -1, fmt.Errorf("JWT validation not configured (no trusted issuers)")
	}
	if len(v.audience) == 0 {
		return -1, fmt.Errorf("JWT validation not configured (no valid audience)")
	}
	var unverified DepositJwtClaims
	if _, _, err := jwt.NewParser().ParseUnverified(token, &unverified); err != nil {
		return -1, fmt.Errorf("parse jwt issuer: %v", err)
	}
	keyFunc, trusted := v.issuers[unverified.Issuer]
	if !trusted {
		return -1, fmt.Errorf("jwt validation: untrusted issuer %q", unverified.Issuer)
	}
	validators := make([]jwt.ParserOption, 0, 4)
	validators = append(validators, jwt.WithValidMethods([]string{"EdDSA"}))
	validators = append(validators, jwt.WithAudience(v.audience...))
	validators = append(validators, jwt.WithIssuer(unverified.Issuer))
	validators = append(validators, jwt.WithExpirationRequired())
	var claims DepositJwtClaims
	_, err := jwt.ParseWithClaims(token, &claims, keyFunc.Keyfunc, validators...)
	if err != nil {
		return -1, fmt.Errorf(
			"validate jwt: %v",
			err,
		)
	}
	if claims.Quantity <= 0 {
		return -1, fmt.Errorf("quota not positive: %d", claims.Quantity)
	}
	if claims.CoinType != v.coinType {
		return -1, fmt.Errorf(
			"expected coin %s but got %s",
			v.coinType.String(),
			claims.CoinType.String(),
		)
	}
	if claims.CoinEnvironment != v.coinEnvironment {
		return -1, fmt.Errorf(
			"expected environment %s but got %s",
			v.coinEnvironment.String(),
			claims.CoinEnvironment.String(),
		)
	}
	expiresAt := time.Time{}
	if claims.ExpiresAt != nil {
		expiresAt = claims.ExpiresAt.Time
	}
	if err := v.redeemer.Redeem(ctx, claims.ID, expiresAt); err != nil {
		return -1, fmt.Errorf("consume jwt: %w", err)
	}
	return claims.Quantity, nil
}
