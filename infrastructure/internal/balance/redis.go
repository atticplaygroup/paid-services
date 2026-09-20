package balance

import (
	"context"
	"strconv"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/redis/go-redis/v9"
)

type RedisStore struct {
	client redis.UniversalClient
}

func NewRedisStore(client redis.UniversalClient) *RedisStore {
	return &RedisStore{client: client}
}

func (s *RedisStore) Get(ctx context.Context, principal string) (int64, error) {
	value, err := s.client.Get(ctx, key(principal)).Result()
	if err == redis.Nil {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	balance, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, err
	}
	return balance, nil
}

func (s *RedisStore) Increment(ctx context.Context, principal string, amount int64) (int64, error) {
	return s.client.IncrBy(ctx, key(principal), amount).Result()
}

func (s *RedisStore) Deduct(ctx context.Context, principal string, amount int64) (int64, error) {
	return s.client.DecrBy(ctx, key(principal), amount).Result()
}

func (s *RedisStore) RefreshTTL(ctx context.Context, principal string, ttl time.Duration) error {
	return s.client.Expire(ctx, key(principal), ttl).Err()
}

func key(principal string) string {
	return utils.AuthzKey(principal)
}
