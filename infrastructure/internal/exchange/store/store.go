package store

import (
	"context"

	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/jackc/pgx/v5/pgxpool"
)

type IStore interface {
	db.Querier
	UpsertAccountTx(ctx context.Context, arg UpsertAccountTxParams) (*int64, error)
	WithdrawTx(ctx context.Context, arg WithdrawTxParams) (*int64, error)
	CancelWithdrawTx(ctx context.Context, arg CancelWithdrawTxParams) error
}

type Store struct {
	*db.Queries
	db *pgxpool.Pool
}

func (s *Store) GetConn() *pgxpool.Pool {
	return s.db
}

func NewStore(pgdb *pgxpool.Pool) *Store {
	return &Store{
		db:      pgdb,
		Queries: db.New(pgdb),
	}
}
