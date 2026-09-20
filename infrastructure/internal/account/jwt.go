package account

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

type jwtValidator struct {
	audience              []string
	validExchanges        []string
	validIssuers          []string
	enableIssuerWhitelist bool
	coinType              pb.CoinType
	coinEnvironment       pb.CoinEnvironment
	keyFunc               keyfunc.Keyfunc
	redeemer              Redeemer
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

func newJwtValidator(conf *Config) (*jwtValidator, error) {
	validExchanges := make([]string, 0, len(conf.ValidExchangeHosts))
	for _, hostname := range conf.ValidExchangeHosts {
		if hostname == "" {
			continue
		}
		validExchanges = append(validExchanges, fmt.Sprintf("https://%s/.well-known/jwks.json", hostname))
	}
	var kf keyfunc.Keyfunc
	if len(validExchanges) > 0 {
		var err error
		kf, err = keyfunc.NewDefaultCtx(context.Background(), validExchanges)
		if err != nil {
			return nil, fmt.Errorf("initialize keyfunc: %w", err)
		}
	}
	return &jwtValidator{
		audience:              []string{validAudience(conf.ValidAudience)},
		validExchanges:        validExchanges,
		validIssuers:          conf.ValidIssuers,
		enableIssuerWhitelist: conf.EnableIssuerWhitelist,
		keyFunc:               kf,
		coinType:              pb.CoinType(conf.ValidCoinType),
		coinEnvironment:       pb.CoinEnvironment(conf.ValidCoinEnvironment),
	}, nil
}

func validAudience(value string) string {
	const prefix = "bafk"
	if !strings.HasPrefix(value, prefix) || len(value) <= len(prefix) {
		return ""
	}
	for _, character := range value[len(prefix):] {
		isLetter := character >= 'a' && character <= 'z'
		isCanonicalDigit := character >= '2' && character <= '7'
		if !isLetter && !isCanonicalDigit {
			return ""
		}
	}
	return value
}

type DepositJwtClaims struct {
	*jwt.RegisteredClaims
	Quantity        int64              `json:"quantity"`
	Usage           pb.JwtUsage        `json:"usage"`
	CoinType        pb.CoinType        `json:"coin"`
	CoinEnvironment pb.CoinEnvironment `json:"env"`
}

func (v *jwtValidator) validate(ctx context.Context, token string) (int64, error) {
	if token == "" {
		return -1, fmt.Errorf("empty jwt")
	}
	if v == nil || v.keyFunc == nil {
		return -1, fmt.Errorf("JWT validation not configured (no exchange hostnames)")
	}
	if len(v.audience) == 0 {
		return -1, fmt.Errorf("JWT validation not configured (no valid audience)")
	}
	validators := make([]jwt.ParserOption, 0, 2)
	validators = append(validators, jwt.WithValidMethods([]string{"EdDSA"}))
	validators = append(validators, jwt.WithAudience(v.audience...))
	var claims DepositJwtClaims
	_, err := jwt.ParseWithClaims(token, &claims, v.keyFunc.Keyfunc, validators...)
	if err != nil {
		return -1, fmt.Errorf(
			"validate jwt: %v",
			err,
		)
	}
	// FIXME: iss should be checked to match the signature
	if v.enableIssuerWhitelist && !slices.Contains(v.validIssuers, claims.Issuer) {
		return -1, fmt.Errorf("jwt validation: untrusted issuer %q", claims.Issuer)
	}
	if claims.Quantity <= 0 {
		return -1, fmt.Errorf("quota not positive: %d", claims.Quantity)
	}
	if claims.Usage != pb.JwtUsage_JWT_USAGE_CREATE_SESSION {
		return -1, fmt.Errorf(
			"expected usage %s but got %s",
			pb.JwtUsage_JWT_USAGE_CREATE_SESSION.String(),
			claims.Usage.String(),
		)
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
	if v.redeemer != nil {
		expiresAt := time.Time{}
		if claims.ExpiresAt != nil {
			expiresAt = claims.ExpiresAt.Time
		}
		if err := v.redeemer.Redeem(ctx, claims.ID, expiresAt); err != nil {
			return -1, fmt.Errorf("consume jwt: %w", err)
		}
	}
	return claims.Quantity, nil
}
