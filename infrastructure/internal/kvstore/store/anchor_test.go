package store

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"
	middleware "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"google.golang.org/protobuf/proto"
)

func anchorJWK(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := jwk.PublicKeyOf(priv)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(key)
	if err != nil {
		t.Fatal(err)
	}
	return priv, string(raw)
}

func signAnchor(t *testing.T, priv *ecdsa.PrivateKey, anchor *pb.Anchor) string {
	t.Helper()
	payload := map[string]any{
		"owner":    anchor.GetOwner(),
		"key":      anchor.GetKey(),
		"cid":      anchor.GetCid(),
		"revision": anchor.GetRevision(),
		"v":        anchorDomain,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := jws.Sign(raw, jws.WithKey(jwa.ES256(), priv))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func TestAnchorVerify(t *testing.T) {
	priv, jwkJSON := anchorJWK(t)
	owner, err := utils.FormatPrincipal(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	anchor := &pb.Anchor{
		Owner: owner.String(), Key: "oci/" + owner.String() + "/test/latest",
		Cid: mustRawCID(t, []byte("manifest")), Revision: 1,
		OwnerJwk: jwkJSON,
	}
	anchor.Signature = signAnchor(t, priv, anchor)
	if err := VerifyAnchor(context.Background(), anchor, owner.String()); err != nil {
		t.Fatalf("VerifyAnchor: %v", err)
	}
	if err := VerifyAnchor(context.Background(), anchor, "other"); err == nil {
		t.Fatal("owner mismatch: want error")
	}

	bad := proto.Clone(anchor).(*pb.Anchor)
	bad.Cid = mustRawCID(t, []byte("other-manifest"))
	if err := VerifyAnchor(context.Background(), bad, owner.String()); err == nil {
		t.Fatal("payload mismatch: want error")
	}
}

func TestAnchorPutGet(t *testing.T) {
	ctx := middleware.WithSession(middleware.WithMeter(context.Background(), middleware.NewMeter("anchor")), &middleware.Session{UserId: "anchor"})

	priv, jwkJSON := anchorJWK(t)
	owner, err := utils.FormatPrincipal(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	anchor := &pb.Anchor{Owner: owner.String(), Key: "a", Cid: mustRawCID(t, []byte("x")), Revision: 1, OwnerJwk: jwkJSON}
	anchor.Signature = signAnchor(t, priv, anchor)
	backend := NewProtectedKvStore(NewMemStore(), NewMemStore())
	if err := PutAnchor(ctx, backend, anchor, time.Hour); err != nil {
		t.Fatalf("PutAnchor: %v", err)
	}
	got, err := GetAnchor(ctx, backend, owner.String(), "a")
	if err != nil {
		t.Fatalf("GetAnchor: %v", err)
	}
	if got.GetSignature() != anchor.GetSignature() {
		t.Fatal("stored anchor mismatch")
	}

	stale := proto.Clone(anchor).(*pb.Anchor)
	stale.Revision = 1
	if err := PutAnchor(ctx, backend, stale, time.Hour); err == nil {
		t.Fatal("equal revision: want error")
	}
	newer := proto.Clone(anchor).(*pb.Anchor)
	newer.Revision = 2
	newer.Signature = signAnchor(t, priv, newer)
	if err := PutAnchor(ctx, backend, newer, time.Hour); err != nil {
		t.Fatalf("newer revision: %v", err)
	}
}

func TestGetAnchorNotFound(t *testing.T) {
	ctx := middleware.WithSession(middleware.WithMeter(context.Background(), middleware.NewMeter("anchor")), &middleware.Session{UserId: "anchor"})
	backend := NewProtectedKvStore(NewMemStore(), NewMemStore())
	if _, err := GetAnchor(ctx, backend, "missing-owner", "missing-key"); err == nil {
		t.Fatal("missing anchor: want error")
	}
}

func TestThumbprintVector(t *testing.T) {
	priv, _ := anchorJWK(t)
	thumb, err := dpop.ThumbprintBytes(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(thumb) != 32 {
		t.Fatalf("thumbprint length %d", len(thumb))
	}
	owner, err := utils.FormatPrincipal(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := base64.RawURLEncoding.DecodeString(owner.String()); err == nil {
		t.Log("owner is not raw base64, expected CID string")
	}
}
