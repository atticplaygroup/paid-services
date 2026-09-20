package balance

import (
	"context"
	"errors"
	"time"
)

var ErrNotFound = errors.New("balance not found")

type Store interface {
	Get(ctx context.Context, principal string) (int64, error)
	Increment(ctx context.Context, principal string, amount int64) (int64, error)
	Deduct(ctx context.Context, principal string, amount int64) (int64, error)
	RefreshTTL(ctx context.Context, principal string, ttl time.Duration) error
}
