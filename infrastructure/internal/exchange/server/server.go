package server

import (
	"context"
	"log"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
)

type Server struct {
	pb.ExchangeServiceServer
	config        *exchange.Config
	store         *store.Store
	auth          exchange.Auth
	paymentClient exchange.PaymentClient
}

func (s *Server) Ping(ctx context.Context, _ *connect.Request[pb.PingRequest]) (*connect.Response[pb.PingResponse], error) {
	return connect.NewResponse(&pb.PingResponse{
		Pong: "pong",
	}), nil
}

func (s *Server) ListPaymentMethods(
	ctx context.Context,
	req *connect.Request[pb.ListPaymentMethodsRequest],
) (*connect.Response[pb.ListPaymentMethodsResponse], error) {
	return connect.NewResponse(&pb.ListPaymentMethodsResponse{
		// TODO: Support other options
		PaymentMethods: []*pb.PaymentMethod{
			{
				Coin:        *pb.PaymentCoin_PAYMENT_COIN_SUI.Enum(),
				Environment: *pb.PaymentEnvironment_PAYMENT_ENVIRONMENT_DEVNET.Enum(),
				Address:     s.config.WalletSigner.Address,
			},
			{
				Coin:        *pb.PaymentCoin_PAYMENT_COIN_SUI.Enum(),
				Environment: *pb.PaymentEnvironment_PAYMENT_ENVIRONMENT_LOCALNET.Enum(),
				Address:     s.config.WalletSigner.Address,
			},
		},
	}), nil
}

func NewServer(config *exchange.Config, store *store.Store) (*Server, error) {
	paymentClient, err := exchange.NewSuiPaymentClient(config.SuiNetwork, &config.WalletSigner)
	if err != nil {
		log.Fatalf("initialize sui client: %v", err)
	}
	authentication, err := exchange.NewAuth(config)
	if err != nil {
		log.Fatalf("Cannot initialize auth: %v", err)
	}
	return &Server{
		config:        config,
		store:         store,
		auth:          *authentication,
		paymentClient: paymentClient,
	}, nil
}

func (s *Server) GetConfig() *exchange.Config {
	return s.config
}
