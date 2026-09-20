package store

import (
	"context"
	"io"
	"time"
)

type StatResult struct {
	Exists bool
	Key    string
	Name   string
	Size   int64
	Ttl    time.Duration
}

type IKvStore interface {
	Exists(ctx context.Context, keys ...string) (int64, error)
	Stat(ctx context.Context, keys ...string) ([]StatResult, error)
	GetTtl(ctx context.Context, key string) (*time.Duration, error)
	ExtendTtl(ctx context.Context, key string, ttl time.Duration) error
	Get(ctx context.Context, key string) (bytes []byte, err error)
	GetStream(ctx context.Context, key string) (io.ReadCloser, error)
	Put(ctx context.Context, key string, value []byte, ttl time.Duration) error
	PutStream(ctx context.Context, key string, r io.Reader, ttl time.Duration) error
	Rename(ctx context.Context, oldKey string, newKey string) error
	Close() error
}
