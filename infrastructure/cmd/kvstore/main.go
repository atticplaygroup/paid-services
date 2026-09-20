package main

import (
	"log"

	kvstore "github.com/atticplaygroup/paid-services/infrastructure/internal/kvstore"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1/kvstoreconnect"
)

func main() {
	conf := kvstore.LoadConfig(".env", ".")
	kvstoreServer, err := kvstore.NewServer(&conf)
	if err != nil {
		log.Fatalf("cannot init server: %v", err)
	}

	path, handler := kvstoreconnect.NewMeteredStorageServiceHandler(
		kvstoreServer,
		connecthttp.ConnectOptions(
			middleware.NewAuthInterceptor(&middleware.AuthConfig{
				UserIdHeaderName:            conf.UserIdHeaderName,
				RequestIdHeaderName:         conf.RequestIdHeaderName,
				ExternalRequestIdHeaderName: conf.ExternalRequestIdHeaderName,
			}),
			middleware.NewConnectValidationInterceptor(connecthttp.NewValidator()),
			middleware.NewReportUsageInterceptor(conf.BillingServerAddress),
		)...,
	)
	connecthttp.Serve(connecthttp.Options{
		Address: connecthttp.Address(conf.ListenAddress, conf.GrpcPort),
		Handlers: append([]connecthttp.Handler{{Path: path, Handler: handler}},
			connecthttp.ReflectHandlers(kvstoreconnect.MeteredStorageServiceName)...),
	})
}
