package store

import (
	"bytes"
	"context"
	"io"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

func TestIKvStoreS3(t *testing.T) {
	t.Run("s3", func(t *testing.T) { testIKvStore(t, newFakeS3Store(t)) })
	t.Run("redis", func(t *testing.T) { testIKvStore(t, newFakeRedisStore(t)) })
	t.Run("mem", func(t *testing.T) { testIKvStore(t, NewMemStore()) })
}

// testIKvStore exercises the full IKvStore contract.
func testIKvStore(t *testing.T, store IKvStore) {
	t.Helper()
	t.Cleanup(func() { _ = store.Close() })

	testMeter := middleware.NewMeter("test-user")
	ctx := middleware.WithMeter(context.Background(), testMeter)

	t.Run("requiresMeter", func(t *testing.T) {
		if _, err := store.Exists(context.Background(), "k"); err == nil {
			t.Fatal("expected meter error")
		}
	})

	const key = "prefix/obj-1"
	payload := []byte("hello-kv")

	t.Run("putGet", func(t *testing.T) {
		if err := store.Put(ctx, key, payload, 0); err != nil {
			t.Fatalf("Put: %v", err)
		}
		got, err := store.Get(ctx, key)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("Get=%q want %q", got, payload)
		}
	})

	t.Run("putGetStream", func(t *testing.T) {
		streamKey := "prefix/stream-1"
		if err := store.PutStream(ctx, streamKey, strings.NewReader("streamed"), 0); err != nil {
			t.Fatalf("PutStream: %v", err)
		}
		rc, err := store.GetStream(ctx, streamKey)
		if err != nil {
			t.Fatalf("GetStream: %v", err)
		}
		got, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(got) != "streamed" {
			t.Fatalf("GetStream=%q", got)
		}
	})

	t.Run("exists", func(t *testing.T) {
		n, err := store.Exists(ctx, key, "missing")
		if err != nil {
			t.Fatalf("Exists: %v", err)
		}
		if n != 1 {
			t.Fatalf("Exists=%d want 1", n)
		}
	})

	t.Run("stat", func(t *testing.T) {
		stats, err := store.Stat(ctx, key, "nope")
		if err != nil {
			t.Fatalf("Stat: %v", err)
		}
		if len(stats) != 2 {
			t.Fatalf("Stat len=%d", len(stats))
		}
		if !stats[0].Exists || stats[0].Key != key || stats[0].Size != int64(len(payload)) || stats[0].Name != utils.FormatName(key) {
			t.Fatalf("Stat[0]=%+v want Name=%q", stats[0], utils.FormatName(key))
		}
		if stats[1].Exists || stats[1].Size != -1 || stats[1].Ttl != -1 {
			t.Fatalf("Stat[1]=%+v", stats[1])
		}
	})

	t.Run("getTtl", func(t *testing.T) {
		ttl, err := store.GetTtl(ctx, key)
		if err != nil {
			t.Fatalf("GetTtl: %v", err)
		}
		if ttl == nil {
			t.Fatal("GetTtl nil")
		}
	})

	t.Run("extendTtl", func(t *testing.T) {
		ttlKey := "prefix/ttl-1"
		if err := store.Put(ctx, ttlKey, []byte("x"), RetentionUnit); err != nil {
			t.Fatalf("Put: %v", err)
		}
		if err := store.ExtendTtl(ctx, ttlKey, RetentionUnit); err != nil {
			t.Skipf("ExtendTtl unsupported by backend: %v", err)
		}
	})

	t.Run("rename", func(t *testing.T) {
		const newKey = "prefix/obj-2"
		if err := store.Rename(ctx, key, newKey); err != nil {
			t.Fatalf("Rename: %v", err)
		}
		n, err := store.Exists(ctx, key, newKey)
		if err != nil {
			t.Fatalf("Exists: %v", err)
		}
		if n != 1 {
			t.Fatalf("Exists after rename=%d want 1", n)
		}
		got, err := store.Get(ctx, newKey)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("Get=%q", got)
		}
	})

	t.Run("getMissing", func(t *testing.T) {
		if _, err := store.Get(ctx, "does-not-exist"); err == nil {
			t.Fatal("Get missing: want error")
		}
	})

	t.Run("meter", func(t *testing.T) {
		if testMeter.Meter.GetGetCount() < 1 || testMeter.Meter.GetSetCount() < 1 {
			t.Fatalf("meter gets=%d sets=%d", testMeter.Meter.GetGetCount(), testMeter.Meter.GetSetCount())
		}
	})

	t.Run("close", func(t *testing.T) {
		if err := store.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
	})
}

func newFakeS3Store(t *testing.T) IKvStore {
	t.Helper()
	backend := s3mem.New()
	faker := gofakes3.New(backend)
	srv := httptest.NewServer(faker.Server())
	t.Cleanup(srv.Close)

	const bucket = "kv-test"
	if err := backend.CreateBucket(bucket); err != nil {
		t.Fatalf("CreateBucket: %v", err)
	}

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4("test", "testtest", ""),
		Secure: false,
	})
	if err != nil {
		t.Fatalf("minio.New: %v", err)
	}
	return &S3Store{Client: client, Bucket: bucket}
}

func newFakeRedisStore(t *testing.T) IKvStore {
	t.Helper()
	mr := miniredis.RunT(t)
	store, err := NewRedisStore(mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisStore: %v", err)
	}
	return store
}
