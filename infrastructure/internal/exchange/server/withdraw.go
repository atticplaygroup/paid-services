package server

import (
	"context"
	"encoding/hex"
	"fmt"
	"log/slog"
	"sync"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/jackc/pgx/v5/pgtype"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) CreateWithdraw(
	ctx context.Context, connectReq *connect.Request[pb.CreateWithdrawRequest],
) (*connect.Response[pb.CreateWithdrawResponse], error) {
	req := connectReq.Msg
	// TODO: change priority fee mechanism to second price
	// TODO: meter usage and deduct in ALS
	chainAddressBytes, err := hex.DecodeString(req.GetWithdrawal().GetAddressTo()[2:])
	if err != nil || len(chainAddressBytes) != 32 {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"failed to parse address: %v",
			err,
		)
	}
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.Unauthenticated,
			"session",
		)
	}
	withdrawal, err := s.store.WithdrawTx(ctx, store.WithdrawTxParams{
		WithdrawAll: req.GetWithdrawAll(),
		StartWithdrawalParams: db.StartWithdrawalParams{
			Principal:       session.UserId,
			WithdrawAddress: chainAddressBytes,
			Amount:          req.GetWithdrawal().GetAmount(),
			PriorityFee:     req.GetWithdrawal().GetPriorityFee(),
		},
	})
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to execute withdrawTx",
		)
	}
	return connect.NewResponse(&pb.CreateWithdrawResponse{
		Withdrawal: &pb.Withdrawal{
			Owner:        session.UserId,
			WithdrawalId: withdrawal.WithdrawalID,
			AddressTo:    req.GetWithdrawal().GetAddressTo(),
			Amount:       withdrawal.Amount,
			PriorityFee:  withdrawal.PriorityFee,
		},
	}), nil
}

func (s *Server) BatchProcessWithdraws(
	ctx context.Context,
	connectReq *connect.Request[pb.BatchProcessWithdrawsRequest],
) (*connect.Response[pb.BatchProcessWithdrawsResponse], error) {
	req := connectReq.Msg
	if req.GetLimit() > s.config.WithdrawRecipientCount || req.GetLimit() <= 0 {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"limit exceeds valid range (0, %d]",
			s.config.WithdrawRecipientCount,
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
	defer func() { _ = tx.Rollback(context.Background()) }()
	qtx := s.store.WithTx(tx)
	withdrawals, err := qtx.SelectCandidateWithdrawals(
		ctx, int32(req.GetLimit()))
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to select withdraw candidates db",
		)
	}
	if len(withdrawals) == 0 {
		return connect.NewResponse(&pb.BatchProcessWithdrawsResponse{
			BatchSize: 0,
		}), nil
	}

	transferInfo := make([]exchange.TransferInfo, 0)
	withdrawIds := make([]int64, 0)
	totalPriorityFee := int64(0)
	for _, withdrawal := range withdrawals {
		transferInfo = append(transferInfo, exchange.TransferInfo{
			Address: hex.EncodeToString(withdrawal.WithdrawAddress),
			Amount:  withdrawal.Amount,
		})
		withdrawIds = append(withdrawIds, withdrawal.WithdrawalID)
		totalPriorityFee += withdrawal.PriorityFee
	}
	suiTx, err := s.paymentClient.PrepareWithdrawTransaction(ctx, transferInfo, uint64(totalPriorityFee))
	if err != nil {
		return nil, err
	}

	processingWithdrawal, err := qtx.SetWithdrawalBatch(
		ctx, db.SetWithdrawalBatchParams{
			TransactionDigest:      suiTx.Transaction.GetDigest(),
			TransactionBcsTypeName: suiTx.Transaction.GetBcs().GetName(),
			TransactionBcsBytes:    suiTx.Transaction.GetBcs().GetValue(),
			TotalPriorityFee:       totalPriorityFee,
		})
	if err != nil {
		return nil, fmt.Errorf("set withdrawal batch: %w", err)
	}
	_, err = qtx.ProcessWithdrawals(ctx, db.ProcessWithdrawalsParams{
		WithdrawalIds: withdrawIds,
		ProcessingWithdrawalID: pgtype.Int8{
			Int64: processingWithdrawal.ProcessingWithdrawalID,
			Valid: true,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("update withdraw status: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		// Users will lose money in the rare case when commit succeeds inside the DB
		// but somehow timeouts and returns an error. Even in this case we choose to maintain the
		// autonomy of exchange instance by letting the users lose money instead of the platform.
		// But exchange operators are still incentivized not to abuse users by tampering
		// the DB connection as it will harm the exchange instance's reputation.
		return nil, fmt.Errorf("commit database change: %w", err)
	}

	digest, err := s.paymentClient.Withdraw(ctx, suiTx)
	if err != nil {
		// Users will lose money here, and it has a much higher risk than db connection which is in
		// control of the exchange operator. But we argue here that this is still not a big problem
		// because Sui transactions are idempotent. If one fails we can replay the same transaction.
		// A TODO is to add an API to replay a transaction automatically given a digest if all
		// withdrawals are in Processing status. But for now users can contact the exchange instance
		// in case of a transaction failure to replay manually.
		return nil, status.Errorf(
			codes.Internal,
			"failed to call payment: %v",
			err,
		)
	}
	return connect.NewResponse(&pb.BatchProcessWithdrawsResponse{Digest: digest}), nil
}

func (s *Server) BatchMarkWithdraws(
	ctx context.Context,
	connectReq *connect.Request[pb.BatchMarkWithdrawsRequest],
) (*connect.Response[pb.BatchMarkWithdrawsResponse], error) {
	req := connectReq.Msg
	if req.GetLimit() > s.config.WithdrawCheckStatusCount || req.GetLimit() <= 0 {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"limit exceeds valid range (0, %d]",
			s.config.WithdrawCheckStatusCount,
		)
	}
	processingWithdrawals, err := s.store.ListProcessingWithdrawals(
		ctx,
		db.ListProcessingWithdrawalsParams{
			Limit:  req.GetLimit(),
			Offset: 0,
		})
	if err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"failed to list processing withdrawals from db: %v",
			err,
		)
	}
	successChan := make(chan int64)
	var wg sync.WaitGroup
	for _, withdraw := range processingWithdrawals {
		transactionDigestHex := withdraw.TransactionDigest
		wg.Add(1)
		go func() {
			defer wg.Done()
			transactionStatus, err := s.paymentClient.CheckTransactionStatus(
				ctx,
				withdraw.TransactionDigest,
			)
			if err != nil {
				slog.ErrorContext(
					ctx,
					fmt.Sprintf("check transaction status failed for transactionDigest %s: %v",
						transactionDigestHex,
						err,
					))
				return
			}
			switch transactionStatus {
			case exchange.SUCCESS:
				if processingWithdrawal, err := s.store.SetWithdrawalSuccess(
					ctx,
					withdraw.TransactionDigest,
				); err != nil {
					slog.ErrorContext(
						ctx,
						fmt.Sprintf("set %s success in db failed: %v", transactionDigestHex, err))
				} else {
					successChan <- processingWithdrawal.ProcessingWithdrawalID
				}
			case exchange.PENDING:
				slog.InfoContext(ctx, fmt.Sprintf("%s is pending", transactionDigestHex))
			default:
				slog.ErrorContext(
					ctx,
					fmt.Sprintf(
						"got undefined status for %s: %d",
						transactionDigestHex,
						transactionStatus,
					))
			}
		}()
	}

	wg.Wait()
	close(successChan)

	successIds := make([]int64, 0)
	for id := range successChan {
		successIds = append(successIds, id)
	}
	return connect.NewResponse(&pb.BatchMarkWithdrawsResponse{
		SuccessWithdrawIds: successIds,
	}), nil
}
