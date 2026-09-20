package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	meterpkg "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

type memObj struct {
	data      []byte
	expiresAt time.Time // zero = no expiry
}

// MemStore is an in-memory IKvStore for tests.
type MemStore struct {
	mu   sync.Mutex
	data map[string]memObj
}

func NewMemStore() *MemStore {
	return &MemStore{data: make(map[string]memObj)}
}

func (m *MemStore) Exists(ctx context.Context, keys ...string) (int64, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return -1, fmt.Errorf("get usage: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var n int64
	for _, key := range keys {
		usage.IncrGetCount()
		if _, ok := m.getLocked(key); ok {
			n++
		}
	}
	return n, nil
}

func (m *MemStore) Stat(ctx context.Context, keys ...string) ([]StatResult, error) {
	statMeter, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	ret := make([]StatResult, 0, len(keys))
	for _, key := range keys {
		statMeter.IncrGetCount()
		if obj, ok := m.getLocked(key); ok {
			ttl := time.Duration(-1)
			if !obj.expiresAt.IsZero() {
				ttl = time.Until(obj.expiresAt)
			}
			ret = append(ret, StatResult{
				Key: key, Name: utils.FormatName(key), Exists: true,
				Size: int64(len(obj.data)), Ttl: ttl,
			})
		} else {
			ret = append(ret, StatResult{
				Key: key, Name: utils.FormatName(key), Exists: false,
				Size: -1, Ttl: -1,
			})
		}
	}
	return ret, nil
}

func (m *MemStore) GetTtl(ctx context.Context, key string) (*time.Duration, error) {
	results, err := m.Stat(ctx, key)
	if err != nil || len(results) != 1 {
		return nil, fmt.Errorf("GetTtl: %w", err)
	}
	return &results[0].Ttl, nil
}

func (m *MemStore) ExtendTtl(ctx context.Context, key string, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	usage.IncrGetCount()
	obj, ok := m.getLocked(key)
	if !ok {
		return fmt.Errorf("%s: not found", key)
	}
	usage.IncrSetCount()
	if obj.expiresAt.IsZero() {
		obj.expiresAt = time.Now().Add(ttl)
	} else {
		obj.expiresAt = obj.expiresAt.Add(ttl)
	}
	m.data[key] = obj
	return nil
}

func (m *MemStore) Get(ctx context.Context, key string) ([]byte, error) {
	rc, err := m.GetStream(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	return io.ReadAll(rc)
}

func (m *MemStore) GetStream(ctx context.Context, key string) (io.ReadCloser, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	usage.IncrGetCount()
	obj, ok := m.getLocked(key)
	if !ok {
		return nil, fmt.Errorf("%s: not found", key)
	}
	return io.NopCloser(bytes.NewReader(obj.data)), nil
}

func (m *MemStore) Put(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return m.PutStream(ctx, key, bytes.NewReader(value), ttl)
}

func (m *MemStore) PutStream(ctx context.Context, key string, r io.Reader, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	usage.IncrSetCount()
	obj := memObj{data: data}
	if ttl > 0 {
		obj.expiresAt = time.Now().Add(ttl)
	}
	m.data[key] = obj
	return nil
}

func (m *MemStore) Rename(ctx context.Context, oldKey, newKey string) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	usage.IncrGetCount()
	obj, ok := m.getLocked(oldKey)
	if !ok {
		return fmt.Errorf("%s: not found", oldKey)
	}
	usage.IncrSetCount()
	m.data[newKey] = obj
	usage.IncrSetCount()
	delete(m.data, oldKey)
	return nil
}

func (m *MemStore) Close() error { return nil }

func (m *MemStore) getLocked(key string) (memObj, bool) {
	obj, ok := m.data[key]
	if !ok {
		return memObj{}, false
	}
	if !obj.expiresAt.IsZero() && time.Now().After(obj.expiresAt) {
		delete(m.data, key)
		return memObj{}, false
	}
	return obj, true
}
