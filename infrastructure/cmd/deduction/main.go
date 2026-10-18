package main

import (
	"log"
	"net"
	"net/http"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/deduction"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1/accountconnect"
	alsv3 "github.com/envoyproxy/go-control-plane/envoy/service/accesslog/v3"
	"google.golang.org/grpc"
)

func main() {
	conf := deduction.LoadConfig(".env", ".")
	srv, err := deduction.New(conf)
	if err != nil {
		log.Fatalf("initialize deduction: %v", err)
	}

	grpcAddr := conf.ListenAddr
	lis, err := net.Listen("tcp", grpcAddr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	s := grpc.NewServer()
	alsv3.RegisterAccessLogServiceServer(s, srv)
	log.Printf("accesslog listening on %s", grpcAddr)
	go func() {
		if err := s.Serve(lis); err != nil {
			log.Fatalf("grpc serve: %v", err)
		}
	}()

	connectAddr := conf.ConnectListenAddr
	mux := http.NewServeMux()
	path, handler := accountconnect.NewDeductionServiceHandler(
		srv,
	)
	mux.Handle(path, handler)

	log.Printf("deduction service listening on %s", connectAddr)
	connecthttp.Serve(connecthttp.Options{
		Address:  connectAddr,
		Handlers: []connecthttp.Handler{{Path: path, Handler: handler}},
	})
}
