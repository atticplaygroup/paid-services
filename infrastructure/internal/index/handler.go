package index

import (
	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1/indexconnect"
	"net/http"
)

func NewHandler(server *Server) (string, http.Handler) {
	options := connecthttp.ConnectOptions(
		middleware.NewAuthInterceptor(&middleware.AuthConfig{UserIdHeaderName: "x-user-id", RequestIdHeaderName: "x-request-id", ExternalRequestIdHeaderName: "x-external-request-id"}),
		middleware.NewConnectValidationInterceptor(connecthttp.NewValidator()),
	)
	// The index only uses gateway metering; there is no application usage RPC.
	options = append(options, connect.WithReadMaxBytes(1<<20))
	return indexconnect.NewIndexServiceHandler(server, options...)
}
