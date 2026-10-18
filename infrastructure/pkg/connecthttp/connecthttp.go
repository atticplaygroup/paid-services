// Package connecthttp provides shared HTTP transport wiring for Connect services.
package connecthttp

import (
	"fmt"
	"log"
	"net/http"

	"buf.build/go/protovalidate"
	"connectrpc.com/connect"
	connectcors "connectrpc.com/cors"
	"connectrpc.com/grpcreflect"
	"github.com/rs/cors"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
)

type Options struct {
	Address       string
	Handlers      []Handler
	ExtraHandlers []Route
}

type Handler struct {
	Path    string
	Handler http.Handler
}

type Route struct {
	Pattern string
	Handler http.Handler
}

func ConnectOptions(interceptors ...connect.Interceptor) []connect.HandlerOption {
	return []connect.HandlerOption{connect.WithInterceptors(interceptors...)}
}

func ReflectHandlers(serviceNames ...string) []Handler {
	reflector := grpcreflect.NewStaticReflector(serviceNames...)
	v1Path, v1Handler := grpcreflect.NewHandlerV1(reflector)
	v1AlphaPath, v1AlphaHandler := grpcreflect.NewHandlerV1Alpha(reflector)
	return []Handler{
		{Path: v1Path, Handler: v1Handler},
		{Path: v1AlphaPath, Handler: v1AlphaHandler},
	}
}

func NewValidator() protovalidate.Validator {
	validator, err := protovalidate.New()
	if err != nil {
		log.Fatalf("initialize protovalidator: %v", err)
	}
	return validator
}

func AuthConfig(userIDHeader, requestIDHeader string) *middleware.AuthConfig {
	return &middleware.AuthConfig{
		UserIdHeaderName:    userIDHeader,
		RequestIdHeaderName: requestIDHeader,
	}
}

func Address(host string, port uint16) string {
	return fmt.Sprintf("%s:%d", host, port)
}

func Serve(options Options) {
	mux := http.NewServeMux()
	for _, handler := range options.Handlers {
		mux.Handle(handler.Path, handler.Handler)
	}
	for _, route := range options.ExtraHandlers {
		mux.Handle(route.Pattern, route.Handler)
	}

	corsHandler := CORS().Handler(mux)
	log.Printf("server started at %s", options.Address)
	server := &http.Server{
		Addr:    options.Address,
		Handler: corsHandler,
	}
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	server.Protocols = protocols
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("http serve: %v", err)
	}
}

func CORS() *cors.Cors {
	return cors.New(cors.Options{
		AllowOriginFunc:  func(string) bool { return true },
		AllowedMethods:   connectcors.AllowedMethods(),
		AllowedHeaders:   append(connectcors.AllowedHeaders(), "Authorization"),
		ExposedHeaders:   connectcors.ExposedHeaders(),
		AllowCredentials: true,
	})
}
