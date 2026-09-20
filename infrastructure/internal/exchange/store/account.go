package store

import (
	"context"
	"fmt"

	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	"github.com/jackc/pgx/v5/pgtype"
)

type UpsertAccountTxParams struct {
	db.UpsertAccountParams
	Digest string
	Epoch  int64
}

func (s *Store) DoUpsertAccountWithTx(
	ctx context.Context,
	qtx *db.Queries,
	arg *UpsertAccountTxParams,
) (*db.Account, error) {
	if arg.Balance < 0 || arg.Ttl.Microseconds < 0 || arg.Ttl.Days < 0 || arg.Ttl.Months < 0 {
		return nil, fmt.Errorf("expect deposit balance and ttl to be non negative but got %d and %v", arg.Balance, arg.Ttl)
	}
	account, err := qtx.UpsertAccount(ctx, arg.UpsertAccountParams)
	if err != nil {
		return nil, err
	}
	if _, err = qtx.AddDepositRecord(ctx, db.AddDepositRecordParams{
		AccountID:         account.AccountID,
		TransactionDigest: arg.Digest,
		Epoch:             arg.Epoch,
	}); err != nil {
		return nil, fmt.Errorf("AddDepositRecord failed: %w", err)
	}
	return &account, nil
}

func (s *Store) UpsertAccountTx(ctx context.Context, arg *UpsertAccountTxParams) (*db.Account, error) {
	tx, err := s.db.Begin(context.Background())
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	qtx := s.WithTx(tx)
	account, err := s.DoUpsertAccountWithTx(ctx, qtx, arg)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(context.Background()); err != nil {
		return nil, err
	}
	return account, nil
}

type BuyTokenTxParams struct {
	Req            *pb.BuyTokenRequest
	BuyerPrincipal string
}

func (s *Store) BuyTokenTx(
	ctx context.Context,
	qtx *db.Queries,
	arg *BuyTokenTxParams,
) error {
	// TODO: Meter usage and deduct in ALS.
	_, err := qtx.ChangeBalance(ctx, db.ChangeBalanceParams{
		Principal:     arg.BuyerPrincipal,
		BalanceChange: -arg.Req.GetAmount(),
	})
	if err != nil {
		return fmt.Errorf("debit buyer: %w", err)
	}
	// TODO: deduct seller for ttl if seller does not exist yet
	if _, err := qtx.UpsertAccount(ctx, db.UpsertAccountParams{
		Principal: arg.Req.GetAudience(),
		Balance:   0,
		Privilege: "user",
		Ttl: pgtype.Interval{
			Microseconds: int64(24*3600) * 1000000,
			Valid:        true,
		},
	}); err != nil {
		return fmt.Errorf("upsert seller: %w", err)
	}
	_, err = qtx.ChangeBalance(ctx, db.ChangeBalanceParams{
		Principal:     arg.Req.GetAudience(),
		BalanceChange: arg.Req.GetAmount(),
	})
	if err != nil {
		return fmt.Errorf("credit seller: %w", err)
	}
	return nil
}
