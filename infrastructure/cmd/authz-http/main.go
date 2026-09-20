// Command authz-http: Envoy ext_authz for self-issued DPoP Bearer JWT → jkt.
package main

import (
	"log"
	"net"

	authzhttp "github.com/atticplaygroup/paid-services/infrastructure/internal/authz-http"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	"google.golang.org/grpc"
)

func main() {
	conf := authzhttp.LoadConfig(".env", ".")
	srv, err := authzhttp.New(conf)
	if err != nil {
		log.Fatalf("initialize authz-http: %v", err)
	}

	lis, err := net.Listen("tcp", conf.ListenAddr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	s := grpc.NewServer()
	authv3.RegisterAuthorizationServer(s, srv)
	log.Printf("authz-http listening on %s (DPoP Bearer → jkt)", conf.ListenAddr)
	if err := s.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
