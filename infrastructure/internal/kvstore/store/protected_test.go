package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"strings"
	"testing"
	"time"

	middleware "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

func TestProtectedKvStore(t *testing.T) {
	p := NewProtectedKvStore(NewMemStore(), NewMemStore())
	ctx := protectedCtx("alice")
	ttl := time.Hour

	t.Run("selfReadPutGet", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		const key = "notes/a"
		payload := []byte("secret-for-alice")

		resp, err := p.Put(ctx, md, key, payload, ttl)
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		wantName := utils.FormatProtectedName("alice", key)
		if resp.Name != wantName {
			t.Fatalf("Name=%q want %q", resp.Name, wantName)
		}

		got, err := p.Get(ctx, "alice", key)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("Get=%q want %q", got, payload)
		}
	})

	t.Run("selfReadDeniesOtherUser", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		const key = "notes/b"
		if _, err := p.Put(ctx, md, key, []byte("x"), ttl); err != nil {
			t.Fatalf("Put: %v", err)
		}
		other := protectedCtx("bob")
		if _, err := p.Get(other, "alice", key); err == nil {
			t.Fatal("bob reading alice key: want error")
		}
		if err := p.ExtendTtl(other, "alice", key, ttl); err == nil {
			t.Fatal("bob ExtendTtl: want unauthorized")
		}
	})

	t.Run("selfReadRequiresSession", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		meterOnly := middleware.WithMeter(context.Background(), middleware.NewMeter("anon"))
		if _, err := p.Put(meterOnly, md, "k", []byte("v"), ttl); err == nil {
			t.Fatal("Put without session: want error")
		}
	})

	t.Run("contentAddressedPutGet", func(t *testing.T) {
		payload := []byte("public-bytes")
		cidKey := mustRawCID(t, payload)
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED,
			Codec:             pb.Codec_CODEC_RAW,
		}
		resp, err := p.Put(ctx, md, cidKey, payload, ttl)
		if err != nil {
			t.Fatalf("Put: %v", err)
		}
		if resp.Name != utils.FormatProtectedName(PublicUserName, cidKey) {
			t.Fatalf("Name=%q", resp.Name)
		}
		got, err := p.Get(ctx, PublicUserName, cidKey)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("Get=%q", got)
		}

		bob := protectedCtx("bob")
		if err := p.ExtendTtl(bob, PublicUserName, cidKey, ttl); err != nil {
			t.Fatalf("bob ExtendTtl content-addressed: %v", err)
		}
	})

	t.Run("contentAddressedRejectsKeyMismatch", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED,
			Codec:             pb.Codec_CODEC_RAW,
		}
		if _, err := p.Put(ctx, md, "not-a-cid-of-body", []byte("body"), ttl); err == nil {
			t.Fatal("want key!=cid error")
		}
	})

	t.Run("putGetStream", func(t *testing.T) {
		payload := "streamed-protected"
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		const key = "notes/stream"
		resp, err := p.PutStream(ctx, md, key, strings.NewReader(payload), ttl)
		if err != nil {
			t.Fatalf("PutStream: %v", err)
		}
		if resp.Name != utils.FormatProtectedName("alice", key) {
			t.Fatalf("Name=%q", resp.Name)
		}
		rc, err := p.GetStream(ctx, "alice", key)
		if err != nil {
			t.Fatalf("GetStream: %v", err)
		}
		got, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(got) != payload {
			t.Fatalf("GetStream=%q", got)
		}
	})

	t.Run("ttl", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		const key = "notes/ttl"
		if _, err := p.Put(ctx, md, key, []byte("t"), ttl); err != nil {
			t.Fatalf("Put: %v", err)
		}
		got, err := p.GetTtl(ctx, "alice", key)
		if err != nil {
			t.Fatalf("GetTtl: %v", err)
		}
		if got == nil || *got <= 0 {
			t.Fatalf("GetTtl=%v", got)
		}
		if err := p.ExtendTtl(ctx, "alice", key, ttl); err != nil {
			t.Fatalf("ExtendTtl: %v", err)
		}
	})

	t.Run("publicReadWorldReadOwnerWrite", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_PUBLIC_READ,
			Codec:             pb.Codec_CODEC_RAW,
		}
		const key = "oci/tags/foo/latest"
		payload := []byte("sha256:deadbeef")
		if _, err := p.Put(ctx, md, key, payload, ttl); err != nil {
			t.Fatalf("Put: %v", err)
		}

		got, err := p.Get(ctx, "alice", key)
		if err != nil {
			t.Fatalf("alice Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("Get=%q", got)
		}

		bob := protectedCtx("bob")
		got, err = p.Get(bob, "alice", key)
		if err != nil {
			t.Fatalf("bob Get: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("bob Get=%q", got)
		}

		if err := p.ExtendTtl(bob, "alice", key, ttl); err == nil {
			t.Fatal("bob ExtendTtl: want unauthorized")
		}
		if err := p.ExtendTtl(ctx, "alice", key, ttl); err != nil {
			t.Fatalf("alice ExtendTtl: %v", err)
		}

		next := []byte("sha256:cafebabe")
		if _, err := p.Put(ctx, md, key, next, ttl); err != nil {
			t.Fatalf("alice overwrite: %v", err)
		}
		got, err = p.Get(bob, "alice", key)
		if err != nil {
			t.Fatalf("bob Get after overwrite: %v", err)
		}
		if !bytes.Equal(got, next) {
			t.Fatalf("after overwrite=%q", got)
		}
	})

	t.Run("aclNotImplemented", func(t *testing.T) {
		md := &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_ACL,
			Codec:             pb.Codec_CODEC_RAW,
		}
		if _, err := p.Put(ctx, md, "notes/acl", []byte("x"), ttl); err == nil {
			t.Fatal("ACL Put: want not implemented")
		}
	})
}

func protectedCtx(userID string) context.Context {
	ctx := middleware.WithMeter(context.Background(), middleware.NewMeter(userID))
	return middleware.WithSession(ctx, &middleware.Session{UserId: userID})
}

func mustRawCID(t *testing.T, value []byte) string {
	t.Helper()
	sum := sha256.Sum256(value)
	c, err := utils.DigestToMultihash(sum[:])
	if err != nil {
		t.Fatalf("DigestToMultihash: %v", err)
	}
	return c.String()
}
