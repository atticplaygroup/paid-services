package account

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

// EnableFaucet activates the CreditBalance RPC.
// Call before any RPCs are served.
func EnableFaucet() {
	atomic.StoreInt32(&faucetEnabled, 1)
}

var faucetEnabled int32

// CreditBalance unconditionally credits a user's balance.
// Only available when EnableFaucet() has been called at startup.
func (s *Server) CreditBalance(
	ctx context.Context, req *connect.Request[pb.CreditBalanceRequest],
) (*connect.Response[pb.CreditBalanceResponse], error) {
	if atomic.LoadInt32(&faucetEnabled) == 0 {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"faucet is not enabled; set FAUCET_MODE=true to enable",
		)
	}

	userId := req.Msg.GetUserId()
	amount := req.Msg.GetAmount()

	balance, err := s.balanceStore.Increment(ctx, userId, amount)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "credit balance: %v", err)
	}

	if err := s.balanceStore.RefreshTTL(ctx, userId, utils.AccountDefaultTtl); err != nil {
		log.Printf("warning: refresh balance ttl: %v", err)
	}

	expireTime := time.Now().Add(utils.AccountDefaultTtl)
	acct := &pb.Account{
		AccountId:  userId,
		Balance:    balance,
		ExpireTime: timestamppb.New(expireTime),
	}

	if err := s.ProtoValidator.Validate(acct); err != nil {
		log.Printf("warning: validate faucet account: %v", err)
	}

	return &connect.Response[pb.CreditBalanceResponse]{
		Msg: &pb.CreditBalanceResponse{Account: acct},
	}, nil
}
