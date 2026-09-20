package server

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Token struct {
	*jwt.RegisteredClaims
	Quantity        int64              `json:"quantity"`
	Usage           pb.JwtUsage        `json:"usage"`
	CoinType        pb.CoinType        `json:"coin"`
	CoinEnvironment pb.CoinEnvironment `json:"env"`
}

func (s *Server) generateJwt(audience string, quantity int64) (string, error) {
	claims := &Token{
		RegisteredClaims: &jwt.RegisteredClaims{
			Issuer:    s.config.TokenSigningKeyId,
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			NotBefore: jwt.NewNumericDate(time.Now()),
			Audience:  jwt.ClaimStrings{audience},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(s.config.TokenTtl)),
			ID:        uuid.NewString(),
		},
		Quantity:        quantity,
		Usage:           pb.JwtUsage_JWT_USAGE_CREATE_SESSION,
		CoinType:        pb.CoinType(s.config.TokenCoinType),
		CoinEnvironment: pb.CoinEnvironment(s.config.TokenCoinEnvironment),
	}

	compact, err := s.signToken(claims)
	if err != nil {
		return "", status.Errorf(
			codes.InvalidArgument,
			"failed to sign jwt: %v",
			err,
		)
	}
	return compact, err
}

func (s *Server) signToken(claims *Token) (string, error) {
	token := jwt.NewWithClaims(&jwt.SigningMethodEd25519{}, claims)
	token.Header["kid"] = s.config.TokenSigningKeyId
	return token.SignedString(s.config.TokenSigningPrivateKey)
}

func (s *Server) BuyToken(
	ctx context.Context,
	connectReq *connect.Request[pb.BuyTokenRequest],
) (*connect.Response[pb.BuyTokenResponse], error) {
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.Unauthenticated,
			"session",
		)
	}
	req := connectReq.Msg
	tx, err := s.store.GetConn().Begin(context.Background())
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to begin transaction: %v",
			err,
		)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	qtx := s.store.WithTx(tx)
	err = s.store.BuyTokenTx(ctx, qtx, &store.BuyTokenTxParams{
		Req:            req,
		BuyerPrincipal: session.UserId,
	})
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to execute transaction: %v",
			err,
		)
	}
	jwt, err := s.generateJwt(req.GetAudience(), req.GetAmount())
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to generate jwt: %v",
			err,
		)
	}
	if err = tx.Commit(context.Background()); err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to commit transaction: %v",
			err,
		)
	}
	return connect.NewResponse(&pb.BuyTokenResponse{
		Token: jwt,
	}), nil
}
