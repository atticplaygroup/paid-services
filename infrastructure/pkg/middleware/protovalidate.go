package middleware

import (
	"context"
	"fmt"

	"buf.build/go/protovalidate"
	"connectrpc.com/connect"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

func protoValidation(req any, v protovalidate.Validator) error {
	m, ok := req.(proto.Message)
	if !ok {
		return status.Error(
			codes.InvalidArgument,
			"failed to parse proto",
		)
	}
	if err := v.Validate(m); err != nil {
		return status.Errorf(
			codes.InvalidArgument,
			"parse proto: %v",
			err,
		)
	}
	return nil
}

func NewConnectValidationInterceptor(v protovalidate.Validator) connect.UnaryInterceptorFunc {
	interceptor := func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(
			ctx context.Context,
			req connect.AnyRequest,
		) (connect.AnyResponse, error) {
			if err := protoValidation(req.Any(), v); err != nil {
				return nil, fmt.Errorf("proto validation: %w", err)
			}
			return next(ctx, req)
		})
	}
	return connect.UnaryInterceptorFunc(interceptor)
}
