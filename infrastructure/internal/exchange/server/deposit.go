package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"math"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/block-vision/sui-go-sdk/models"
)

func (s *Server) GetChallenge(ctx context.Context, connectReq *connect.Request[pb.GetChallengeRequest]) (*connect.Response[pb.GetChallengeResponse], error) {
	req := connectReq.Msg
	startTime := s.auth.Clock.Now()
	challenge, err := s.auth.GetChallenge(req.GetAddress(), startTime)
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to get challenge: %v",
			err,
		)
	}
	return connect.NewResponse(&pb.GetChallengeResponse{
		Challenge: challenge[:],
		StartTime: timestamppb.New(startTime),
	}), nil
}

func (s *Server) Deposit(ctx context.Context, connectReq *connect.Request[pb.DepositRequest]) (*connect.Response[pb.DepositResponse], error) {
	req := connectReq.Msg
	if req.GetTtl() == nil || req.GetTtl().Seconds < 0 || req.GetTtl().Seconds > s.config.MaxExpirationExtension {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"ttl seconds not in valid range [0, %d]",
			s.config.MaxExpirationExtension,
		)
	}
	senderInfo, err := s.paymentClient.CheckDeposit(
		ctx, req.GetProof().GetChainDigest(), int(s.config.MaxDepositEpochGap),
	)
	if err != nil {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"digest check failed: %v",
			err,
		)
	}
	if senderInfo.Amount <= 0 {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"got non positive deposit amount: %d",
			senderInfo.Amount,
		)
	}
	ttlFee := int64(math.Ceil(float64(req.GetTtl().Seconds) / 1000.0 * s.config.AccountTtlPrice))
	amountDeposit := senderInfo.Amount - ttlFee
	if amountDeposit < 0 {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"insufficient deposit %d for ttl of %d seconds with price %f",
			senderInfo.Amount,
			req.GetTtl().Seconds,
			s.config.AccountTtlPrice,
		)
	}
	chainAddress := senderInfo.Address
	if len(chainAddress) < 2 {
		return nil, status.Errorf(
			codes.Internal,
			"chain address too short",
		)
	}
	chainAddressBytes, err := hex.DecodeString(chainAddress[2:])
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"chain address parse failed",
		)
	}
	sender, pass, err := models.VerifyPersonalMessage(
		string(req.GetProof().GetChallenge()),
		req.GetProof().GetSignature(),
	)
	if err != nil || !pass {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"personal message verification failed for bytes=%v and signature=%s",
			req.GetProof().GetChallenge(),
			req.GetProof().GetSignature(),
		)
	}
	if err := s.auth.VerifySuiAuthMessagePayload(
		&exchange.SuiAuthMessage{
			StartTime: req.GetProof().GetStartTime().AsTime(),
			Challenge: req.GetProof().GetChallenge(),
			Address:   sender,
			Signature: req.GetProof().GetSignature(),
		},
	); err != nil {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"invalid personal message: %v",
			err,
		)
	}
	signerAddressBytes, err := utils.HexToBytes32(sender)
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to parse signer address: %v",
			err,
		)
	}
	if !bytes.Equal(signerAddressBytes, chainAddressBytes) {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"wrong personal message signer: %v != desired chain address %v",
			signerAddressBytes,
			chainAddressBytes,
		)
	}
	tx, err := s.store.GetConn().Begin(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to init transaction: %v",
			err,
		)
	}

	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.Unauthenticated,
			"get session: %v",
			err,
		)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	qtx := s.store.WithTx(tx)
	account, err := s.store.DoUpsertAccountWithTx(
		ctx, qtx, &store.UpsertAccountTxParams{
			UpsertAccountParams: db.UpsertAccountParams{
				Principal: session.UserId,
				Ttl: pgtype.Interval{
					Microseconds: int64(req.GetTtl().Seconds) * 1000,
					Valid:        true,
				},
				Privilege: "user",
				Balance:   amountDeposit,
			},
			Digest: req.GetProof().GetChainDigest(),
			Epoch:  senderInfo.Epoch,
		})
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"database upsert failed: %v",
			err,
		)
	}
	if err := tx.Commit(context.Background()); err != nil {
		return nil, err
	}
	accountResponse := formatAccount(*account)
	return connect.NewResponse(&pb.DepositResponse{
		Account: &accountResponse,
	}), nil
}

func (s *Server) PruneAccounts(
	ctx context.Context,
	req *connect.Request[pb.PruneAccountsRequest],
) (*connect.Response[pb.PruneAccountsResponse], error) {
	if accountIds, err := s.store.DeleteInvalidAccounts(ctx); err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed: %v",
			err,
		)
	} else {
		ret := make([]*pb.Account, 0)
		for _, accountId := range accountIds {
			account := pb.Account{AccountId: accountId}
			ret = append(ret, &account)
		}
		return connect.NewResponse(&pb.PruneAccountsResponse{
			Accounts: ret,
		}), nil
	}
}

func formatAccount(account db.Account) pb.Account {
	return pb.Account{
		AccountId:  account.AccountID,
		Principal:  account.Principal,
		ExpireTime: timestamppb.New(account.ExpireTime.Time),
		Balance:    account.Balance,
	}
}
