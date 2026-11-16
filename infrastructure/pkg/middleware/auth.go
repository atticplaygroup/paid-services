package middleware

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
)

type AuthConfig struct {
	UserIdHeaderName            string
	RequestIdHeaderName         string
	ExternalRequestIdHeaderName string
}

type sessionKey struct{}

type Session struct {
	UserId            string
	RequestId         string
	ExternalRequestId string
}

func NewAuthInterceptor(config *AuthConfig, unprotectedApis ...string) connect.UnaryInterceptorFunc {
	return func(next connect.UnaryFunc) connect.UnaryFunc {
		return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
			for _, authNotRequired := range unprotectedApis {
				if req.Spec().Procedure == authNotRequired {
					return next(ctx, req)
				}
			}

			userId := req.Header().Get(config.UserIdHeaderName)
			if userId == "" {
				return nil, connect.NewError(connect.CodeUnauthenticated, fmt.Errorf("empty user_id"))
			}
			requestId := req.Header().Get(config.RequestIdHeaderName)
			if requestId == "" {
				return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("empty request_id"))
			}
			externalRequestId := req.Header().Get(config.ExternalRequestIdHeaderName)
			return next(context.WithValue(ctx, sessionKey{}, &Session{
				UserId:            userId,
				RequestId:         requestId,
				ExternalRequestId: externalRequestId,
			}), req)
		}
	}
}

func SessionFromContext(ctx context.Context) (*Session, error) {
	session, ok := ctx.Value(sessionKey{}).(*Session)
	if !ok {
		return nil, fmt.Errorf("session not initialized")
	}
	return session, nil
}

func WithSession(ctx context.Context, s *Session) context.Context {
	return context.WithValue(ctx, sessionKey{}, s)
}
