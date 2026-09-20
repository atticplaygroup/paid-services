package store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	meterpkg "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type RedisStore struct {
	redisClient *redis.Client
	bufferSize  int
}

func NewRedisStore(redisAddr string) (*RedisStore, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddr,
	})
	return &RedisStore{
		redisClient: rdb,
		bufferSize:  16 * 1024,
	}, nil
}

func (s *RedisStore) Exists(ctx context.Context, keys ...string) (int64, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return -1, fmt.Errorf("get usage: %w", err)
	}
	usage.IncrGetCountBy(int64(len(keys)))
	return s.redisClient.Exists(ctx, keys...).Result()
}

func (s *RedisStore) Stat(ctx context.Context, keys ...string) ([]StatResult, error) {
	statMeter, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	ret := make([]StatResult, 0, len(keys))
	for _, key := range keys {
		statMeter.IncrGetCount()
		n, err := s.redisClient.Exists(ctx, key).Result()
		if err != nil {
		return nil, fmt.Errorf("exists %s: %w", key, err)
		}
		if n == 0 {
			ret = append(ret, StatResult{
				Key:    key,
				Name:   utils.FormatName(key),
				Exists: false,
				Size:   -1,
				Ttl:    -1,
			})
			continue
		}
		statMeter.IncrGetCount()
		ttl, err := s.redisClient.TTL(ctx, key).Result()
		if err != nil {
		return nil, fmt.Errorf("get ttl for %s: %w", key, err)
		}
		if ttl < 0 {
			ttl = -1
		}
		statMeter.IncrGetCount()
		// STRLEN is the value byte length; MEMORY USAGE is allocator estimate and
		// returns redis.Nil on some backends (e.g. miniredis) for missing/odd keys.
		size, err := s.redisClient.StrLen(ctx, key).Result()
		if err != nil {
		return nil, fmt.Errorf("strlen %s: %w", key, err)
		}
		ret = append(ret, StatResult{
			Key:    key,
			Name:   utils.FormatName(key),
			Size:   size,
			Ttl:    ttl,
			Exists: true,
		})
	}
	return ret, nil
}

func (s *RedisStore) Get(ctx context.Context, key string) (bytes []byte, err error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	usage.IncrGetCount()

	value, err := s.redisClient.Get(ctx, key).Result()
	if err != nil {
		return nil, err
	}
	usage.IncrTempMemoryBytes(int64(len(value)))

	return []byte(value), err
}

func (s *RedisStore) GetTtl(ctx context.Context, key string) (*time.Duration, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	usage.IncrGetCount()

	ttl, err := s.redisClient.TTL(ctx, key).Result()
	return &ttl, err
}

func (s *RedisStore) GetStream(ctx context.Context, key string) (io.ReadCloser, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	pr, pw := io.Pipe()

	go func() {
		defer func() { _ = pw.Close() }()
		seek := 0

		for {
			select {
			case <-ctx.Done():
				pw.CloseWithError(fmt.Errorf("context canceled: %s", ctx.Err().Error()))
				return
			default:
			}

			usage.IncrGetCount()
			if seek == 0 {
				usage.IncrTempMemoryBytes(int64(s.bufferSize))
			}
			value, err := s.redisClient.GetRange(ctx, key, int64(seek), int64(seek+s.bufferSize)).Result()
			if err != nil {
				pw.CloseWithError(fmt.Errorf("get range error: %w", err))
				return
			}
			if len(value) == 0 {
				return
			}
			n, err := pw.Write([]byte(value))
			if err != nil {
				pw.CloseWithError(fmt.Errorf("get range error: %w", err))
				return
			}
			seek += n
		}
	}()

	return pr, nil
}

func (s *RedisStore) ExtendTtl(ctx context.Context, key string, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	usage.IncrGetCount()
	oldTtl, err := s.redisClient.TTL(ctx, key).Result()
	if err != nil {
		return fmt.Errorf("prolong ttl: get ttl: %w", err)
	}
	usage.IncrGetCount()
	valueSize, err := s.redisClient.MemoryUsage(ctx, key).Result()
	if err != nil {
		return fmt.Errorf("prolong ttl: get size: %w", err)
	}
	newTtl := ttl + oldTtl
	usage.IncrSetCount()
	if err = s.redisClient.Expire(ctx, key, newTtl).Err(); err != nil {
		return fmt.Errorf("set ttl")
	}
	usage.IncrStorageByteSeconds(valueSize * int64(ttl.Seconds()))
	return nil
}

func (s *RedisStore) Put(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	usage.IncrGetCount()
	if err := s.redisClient.Set(ctx, key, value, ttl).Err(); err != nil {
		return fmt.Errorf("set value: %w", err)
	}
	valueSize := int64(len(value))
	usage.IncrTempMemoryBytes(valueSize)
	usage.IncrStorageByteSeconds(valueSize * int64(ttl.Seconds()))
	return nil
}

func (s *RedisStore) putTempStream(ctx context.Context, r io.Reader) (int, string, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return -1, "", fmt.Errorf("get usage: %w", err)
	}
	tempKey := uuid.NewString()
	usage.IncrTempMemoryBytes(int64(s.bufferSize))
	buf := make([]byte, s.bufferSize)
	size := 0
	for {
		select {
		case <-ctx.Done():
			return size, tempKey, fmt.Errorf("context canceled: %s", ctx.Err().Error())
		default:
		}

		nRead, err := r.Read(buf)
		if nRead > 0 {
			usage.IncrSetCount()
			// APPEND returns the new total string length, not bytes written this call.
			if err := s.redisClient.Append(ctx, tempKey, string(buf[:nRead])).Err(); err != nil {
				return size, tempKey, fmt.Errorf("write stream: %w", err)
			}
			size += nRead
		}
		if errors.Is(err, io.EOF) {
			return size, tempKey, nil
		}
		if err != nil {
			return size, tempKey, fmt.Errorf("read stream: %w", err)
		}
	}
}

func (s *RedisStore) PutStream(ctx context.Context, key string, r io.Reader, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	valueSize, tempKey, err := s.putTempStream(ctx, r)
	if err != nil {
		usage.IncrSetCount()
		if delErr := s.redisClient.Del(ctx, tempKey).Err(); delErr != nil {
		return fmt.Errorf("put temp stream: %w, delete temp key: %w", err, delErr)
		}
		return fmt.Errorf("put err: %w", err)
	}
	if valueSize == 0 {
		// APPEND never created the key for an empty reader.
		return s.Put(ctx, key, nil, ttl)
	}

	usage.IncrGetCount()
	usage.IncrSetCount()
	if err := s.redisClient.Rename(ctx, tempKey, key).Err(); err != nil {
		return fmt.Errorf("rename: %w", err)
	}

	if ttl > 0 {
		usage.IncrSetCount()
		if err := s.redisClient.Expire(ctx, key, ttl).Err(); err != nil {
			return fmt.Errorf("set expiration: %w", err)
		}
		usage.IncrStorageByteSeconds(int64(valueSize) * int64(ttl.Seconds()))
	}
	return nil
}

func (s *RedisStore) Rename(ctx context.Context, oldKey string, newKey string) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}
	usage.IncrGetCount()
	usage.IncrSetCount()
	if err := s.redisClient.Rename(ctx, oldKey, newKey).Err(); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

func (s *RedisStore) Close() error {
	return s.redisClient.Close()
}
