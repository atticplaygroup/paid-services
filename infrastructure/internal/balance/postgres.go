package balance

import (
	"context"
	"errors"
	"time"

	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

const DefaultTTL = utils.AccountDefaultTtl

func ttlInterval(ttl time.Duration) pgtype.Interval {
	microseconds := (ttl.Microseconds() + 999) / 1000
	return pgtype.Interval{
		Microseconds: microseconds,
		Valid:        true,
	}
}

func NewPostgresStore(ctx context.Context, databaseURL string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &PostgresStore{pool: pool, queries: db.New(pool)}, nil
}

func (s *PostgresStore) Close() {
	s.pool.Close()
}

func (s *PostgresStore) Get(ctx context.Context, principal string) (int64, error) {
	account, err := s.queries.QueryBalance(ctx, principal)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return account.Balance, err
}

func (s *PostgresStore) Increment(ctx context.Context, principal string, amount int64) (int64, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	queries := db.New(tx)
	accountID, err := queries.LockAccountByPrincipal(ctx, principal)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
		if _, err := queries.InsertAccount(ctx, db.InsertAccountParams{
			Principal: principal,
			Balance:   amount,
			Ttl:       ttlInterval(DefaultTTL),
		}); err != nil {
			return 0, err
		}
	} else if err := queries.UpdateAccountBalance(ctx, db.UpdateAccountBalanceParams{
		BalanceChange: amount,
		Ttl:           ttlInterval(DefaultTTL),
		AccountID:     accountID,
	}); err != nil {
		return 0, err
	}

	finalAccount, err := queries.QueryBalance(ctx, principal)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return finalAccount.Balance, nil
}

func (s *PostgresStore) Deduct(ctx context.Context, principal string, amount int64) (int64, error) {
	balance, err := s.queries.DeductBalance(ctx, db.DeductBalanceParams{
		BalanceChange: -amount,
		Principal:     principal,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	return balance, err
}

func (s *PostgresStore) RefreshTTL(ctx context.Context, principal string, ttl time.Duration) error {
	return s.queries.ExtendAccountExpiry(ctx, db.ExtendAccountExpiryParams{
		Principal: principal,
		Ttl:       ttlInterval(ttl),
	})
}
