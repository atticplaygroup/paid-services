package main

import (
	"context"
	"log"
	"net/http"

	"buf.build/go/protovalidate"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/server"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1/exchangeconnect"
)

func main() {
	conf := exchange.LoadConfig(".env")
	log.Printf("conf: %+v", conf)

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, conf.DatabaseURL)
	if err != nil {
		log.Fatalf("connect to db: %v\n", err)
	}
	defer pool.Close()

	server, err := server.NewServer(
		&conf,
		store.NewStore(pool),
	)
	if err != nil {
		log.Fatalf("init server: %v\n", err)
	}

	validator, err := protovalidate.New()
	if err != nil {
		log.Fatalf("initialize protovalidator: %v", err)
	}
	path, handler := exchangeconnect.NewExchangeServiceHandler(
		server,
		connecthttp.ConnectOptions(
			middleware.NewAuthInterceptor(
				connecthttp.AuthConfig(conf.UserIdHeaderName, conf.RequestIdHeaderName),
				pb.ExchangeService_Ping_FullMethodName,
				pb.ExchangeService_ListPaymentMethods_FullMethodName,
				pb.ExchangeService_GetChallenge_FullMethodName,
			),
			middleware.NewConnectValidationInterceptor(validator),
		)...,
	)
	connecthttp.Serve(connecthttp.Options{
		Address: connecthttp.Address(conf.ListenAddress, conf.GrpcPort),
		Handlers: append([]connecthttp.Handler{{Path: path, Handler: handler}},
			connecthttp.ReflectHandlers(exchangeconnect.ExchangeServiceName)...),
		ExtraHandlers: []connecthttp.Route{{
			Pattern: "/.well-known/jwks.json",
			Handler: http.HandlerFunc(server.HandleJWKS),
		}},
	})
}
