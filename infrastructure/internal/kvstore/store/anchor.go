package store

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"fmt"
	"time"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/ipfs/go-cid"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"google.golang.org/protobuf/proto"
)

const anchorDomain = "paid.meter.anchor.v1"

func canonicalAnchorJSON(anchor *pb.Anchor) ([]byte, error) {
	if anchor == nil {
		return nil, fmt.Errorf("nil anchor")
	}
	values := map[string]any{
		"owner":    anchor.GetOwner(),
		"key":      anchor.GetKey(),
		"cid":      anchor.GetCid(),
		"revision": anchor.GetRevision(),
		"v":        anchorDomain,
	}
	return json.Marshal(values)
}

func normalizeAnchorCID(cidString string) (string, error) {
	decoded, err := cid.Decode(cidString)
	if err != nil {
		return "", fmt.Errorf("decode cid: %w", err)
	}
	if decoded.Version() != 1 {
		decoded = cid.NewCidV1(decoded.Prefix().Codec, decoded.Hash())
	}
	if codec := decoded.Prefix().Codec; codec != cid.Raw && codec != cid.DagProtobuf {
		return "", fmt.Errorf("unsupported cid codec %d", codec)
	}
	return decoded.String(), nil
}

func parseOwnerJWK(anchor *pb.Anchor) (*ecdsa.PublicKey, error) {
	if anchor.GetOwnerJwk() == "" {
		return nil, fmt.Errorf("owner_jwk is required in this implementation")
	}
	key, err := jwk.Parse([]byte(anchor.GetOwnerJwk()))
	if err != nil {
		return nil, fmt.Errorf("parse owner jwk: %w", err)
	}
	if key.Len() != 1 {
		return nil, fmt.Errorf("owner jwk must contain one key")
	}
	parsed, ok := key.Key(0)
	if !ok || parsed.Has("d") {
		return nil, fmt.Errorf("owner jwk must be one public key")
	}
	if alg, ok := parsed.Algorithm(); ok && alg.String() != "ES256" {
		return nil, fmt.Errorf("owner jwk algorithm must be ES256")
	}
	var publicKey ecdsa.PublicKey
	if err := jwk.Export(parsed, &publicKey); err != nil {
		return nil, fmt.Errorf("export owner jwk: %w", err)
	}
	if publicKey.Curve != elliptic.P256() {
		return nil, fmt.Errorf("owner jwk curve must be P-256")
	}
	owner, err := utils.FormatPrincipal(&publicKey)
	if err != nil {
		return nil, err
	}
	if owner.String() != anchor.GetOwner() {
		return nil, fmt.Errorf("owner jwk does not derive to owner")
	}
	return &publicKey, nil
}

func VerifyAnchor(ctx context.Context, anchor *pb.Anchor, authenticatedOwner string) error {
	if anchor == nil {
		return fmt.Errorf("nil anchor")
	}
	if anchor.GetRevision() <= 0 {
		return fmt.Errorf("revision must be positive")
	}
	if anchor.GetOwner() != authenticatedOwner {
		return fmt.Errorf("anchor owner does not match authenticated writer")
	}
	if _, err := normalizeAnchorCID(anchor.GetCid()); err != nil {
		return err
	}
	parsed, err := parseOwnerJWK(anchor)
	if err != nil {
		return err
	}
	verified, err := jws.Verify([]byte(anchor.GetSignature()), jws.WithKey(jwa.ES256(), parsed))
	if err != nil {
		return fmt.Errorf("verify anchor signature: %w", err)
	}
	want, err := canonicalAnchorJSON(anchor)
	if err != nil {
		return err
	}
	var got map[string]any
	if err := json.Unmarshal(verified, &got); err != nil {
		return fmt.Errorf("decode anchor payload: %w", err)
	}
	var expected map[string]any
	if err := json.Unmarshal(want, &expected); err != nil {
		return err
	}
	if len(got) != len(expected) {
		return fmt.Errorf("anchor payload has unexpected fields")
	}
	for field, want := range expected {
		actual, ok := got[field]
		if !ok || fmt.Sprint(actual) != fmt.Sprint(want) {
			return fmt.Errorf("anchor payload field %q does not match", field)
		}
	}
	return nil
}

func PutAnchor(ctx context.Context, backend *ProtectedKvStore, anchor *pb.Anchor, ttl time.Duration) error {
	name := utils.FormatProtectedAnchorName(anchor.GetOwner(), anchor.GetKey())
	var current *pb.Anchor
	existingBytes, err := backend.GetRaw(ctx, name)
	if err == nil {
		current = &pb.Anchor{}
		if err := proto.Unmarshal(existingBytes, current); err != nil {
			return fmt.Errorf("unmarshal existing anchor: %w", err)
		}
		if anchor.GetRevision() <= current.GetRevision() {
			return fmt.Errorf("anchor revision %d is not newer than stored revision %d", anchor.GetRevision(), current.GetRevision())
		}
	}
	value, err := proto.Marshal(anchor)
	if err != nil {
		return err
	}
	if current != nil {
		return backend.ReplaceRaw(ctx, name, value, ttl)
	}
	return backend.PutRaw(ctx, name, value, ttl)
}

func GetAnchor(ctx context.Context, backend *ProtectedKvStore, owner, key string) (*pb.Anchor, error) {
	name := utils.FormatProtectedAnchorName(owner, key)
	value, err := backend.GetRaw(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("anchor lookup failed for %q: %w", name, err)
	}
	anchor := &pb.Anchor{}
	if err := proto.Unmarshal(value, anchor); err != nil {
		return nil, fmt.Errorf("unmarshal anchor: %w", err)
	}
	return anchor, nil
}
