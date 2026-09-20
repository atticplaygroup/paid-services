package balance

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	BackendRedis      = "redis"
	BackendExchangeDB = "exchange-db"
	connectTimeout    = 5 * time.Second
)

func NewStore(ctx context.Context, backend string, redisClient redis.UniversalClient, exchangeDatabaseURL string) (Store, error) {
	switch backend {
	case "", BackendRedis:
		pingCtx, cancel := context.WithTimeout(ctx, connectTimeout)
		defer cancel()
		if err := redisClient.Ping(pingCtx).Err(); err != nil {
			return nil, fmt.Errorf("connect redis: %w", err)
		}
		return NewRedisStore(redisClient), nil
	case BackendExchangeDB:
		connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
		defer cancel()
		return NewPostgresStore(connectCtx, exchangeDatabaseURL)
	default:
		return nil, fmt.Errorf("unsupported balance backend: %s", backend)
	}
}
