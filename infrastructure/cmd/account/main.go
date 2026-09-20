package main

import (
	"log"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/account"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1/accountconnect"
)

func main() {
	conf := account.LoadConfig(".env", ".")
	server, err := account.NewServer(&conf)
	if err != nil {
		log.Fatalf("cannot init server: %v", err)
	}

	// Set faucet mode
	if conf.FaucetMode {
		account.EnableFaucet()
		log.Println("FAUCET_MODE enabled — CreditBalance RPC is active")
	}

	path, handler := accountconnect.NewAccountServiceHandler(
		server,
		connecthttp.ConnectOptions(
			middleware.NewAuthInterceptor(connecthttp.AuthConfig(
				conf.UserIdHeaderName,
				conf.RequestIdHeaderName,
			)),
			middleware.NewConnectValidationInterceptor(connecthttp.NewValidator()),
		)...,
	)
	connecthttp.Serve(connecthttp.Options{
		Address: connecthttp.Address(conf.ListenAddress, conf.GrpcPort),
		Handlers: append([]connecthttp.Handler{{Path: path, Handler: handler}},
			connecthttp.ReflectHandlers(accountconnect.AccountServiceName)...),
	})
}
