package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"time"

	middleware "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/google/uuid"
	"github.com/ipfs/boxo/ipld/merkledag"
	"github.com/ipfs/go-cid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

const PublicUserName = "public"

type ProtectedKvStore struct {
	store         IKvStore
	metadataStore IKvStore
}

func NewProtectedKvStore(store, metadataStore IKvStore) *ProtectedKvStore {
	return &ProtectedKvStore{store: store, metadataStore: metadataStore}
}

type PutResponse struct {
	Name string
	Ttl  time.Duration
}

func getOwner(ctx context.Context, mode pb.AuthorizationMode) (string, error) {
	switch mode {
	case pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED:
		return PublicUserName, nil
	case pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ, pb.AuthorizationMode_AUTHORIZATION_MODE_PUBLIC_READ:
		session, err := middleware.SessionFromContext(ctx)
		if err != nil {
			return "", fmt.Errorf("get session: %w", err)
		}
		return session.UserId, nil
	case pb.AuthorizationMode_AUTHORIZATION_MODE_ACL:
		return "", fmt.Errorf("acl mode not implemented yet")
	default:
		return "", fmt.Errorf("unrecognized mode %d", mode)
	}
}

func needsMetadata(mode pb.AuthorizationMode) bool {
	return mode == pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ ||
		mode == pb.AuthorizationMode_AUTHORIZATION_MODE_PUBLIC_READ
}

func (s *ProtectedKvStore) putMetadata(ctx context.Context, md *pb.ValueMetadata, user, key string, ttl time.Duration) error {
	if !needsMetadata(md.GetAuthorizationMode()) {
		return nil
	}
	metadataName := utils.FormatProtectedMetadataName(user, key)
	metadataBytes, err := proto.Marshal(md)
	if err != nil {
		return fmt.Errorf("marshal metadata: %w", err)
	}
	if err := s.metadataStore.Put(ctx, metadataName, metadataBytes, ttl); err != nil {
		return fmt.Errorf("set metadata: %w", err)
	}
	return nil
}

func calculateCid(md *pb.ValueMetadata, value []byte) (string, error) {
	switch md.GetCodec() {
	case pb.Codec_CODEC_DAG_PB:
		protoNode, err := merkledag.DecodeProtobuf(value)
		if err != nil {
			return "", err
		}
		if protoNode.Cid().Prefix().Codec != cid.DagProtobuf {
			return "", fmt.Errorf(
				"expected codec to be dag-pb (%d) but got %d",
				cid.DagProtobuf,
				protoNode.Cid().Prefix().GetCodec(),
			)
		}
		return cid.NewCidV1(cid.DagProtobuf, protoNode.Cid().Hash()).String(), nil
	case pb.Codec_CODEC_RAW:
		h := sha256.New()
		h.Write(value)
		c, err := utils.DigestToMultihash(h.Sum(nil))
		if err != nil {
			return "", err
		}
		return c.String(), nil
	default:
		return "", fmt.Errorf("only raw and dag-pb codec are allowed")
	}
}

func (s *ProtectedKvStore) Put(ctx context.Context, md *pb.ValueMetadata, key string, value []byte, ttl time.Duration) (*PutResponse, error) {
	mode := md.GetAuthorizationMode()
	user, err := getOwner(ctx, mode)
	if err != nil {
		return nil, fmt.Errorf("get owner: %w", err)
	}

	tempKey := uuid.NewString()
	if err := s.store.Put(ctx, tempKey, value, ttl); err != nil {
		return nil, fmt.Errorf("set value: %w", err)
	}

	contentCID, err := calculateCid(md, value)
	if err != nil {
		return nil, fmt.Errorf("calculate cid: %w", err)
	}
	if mode == pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED {
		key, err = normalizeCidToV1(key)
		if err != nil {
			return nil, fmt.Errorf("content-addressed key: %w", err)
		}
		if contentCID != key {
			return nil, fmt.Errorf("content-addressed mode but key %s != cid %s", key, contentCID)
		}
	}
	name := utils.FormatProtectedName(user, key)
	if err := s.store.Rename(ctx, tempKey, name); err != nil {
		return nil, fmt.Errorf("rename value: %w", err)
	}
	if err := s.putMetadata(ctx, md, user, key, ttl); err != nil {
		return nil, fmt.Errorf("put metadata: %w", err)
	}
	return &PutResponse{
		Name: name,
		Ttl:  ttl,
	}, nil
}

func (s *ProtectedKvStore) PutStream(ctx context.Context, md *pb.ValueMetadata, key string, r io.Reader, ttl time.Duration) (*PutResponse, error) {
	mode := md.GetAuthorizationMode()
	if md.GetCodec() != pb.Codec_CODEC_RAW {
		return nil, fmt.Errorf("only allow to upload raw bytes for stream mode but got %d", md.GetCodec())
	}
	user, err := getOwner(ctx, mode)
	if err != nil {
		return nil, fmt.Errorf("get owner: %w", err)
	}

	h := sha256.New()
	tempKey := uuid.NewString()
	if err := s.store.PutStream(ctx, tempKey, io.TeeReader(r, h), ttl); err != nil {
		return nil, fmt.Errorf("put streem: %w", err)
	}

	contentCID, err := utils.DigestToMultihash(h.Sum(nil))
	if err != nil {
		return nil, fmt.Errorf("calculate cid: %w", err)
	}
	if mode == pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED {
		key, err = normalizeCidToV1(key)
		if err != nil {
			return nil, fmt.Errorf("content-addressed key: %w", err)
		}
		if contentCID.String() != key {
			return nil, fmt.Errorf("content-addressed mode but key %s != cid %s", key, contentCID.String())
		}
	}
	name := utils.FormatProtectedName(user, key)
	if err := s.store.Rename(ctx, tempKey, name); err != nil {
		return nil, fmt.Errorf("rename value: %w", err)
	}
	if err := s.putMetadata(ctx, md, user, key, ttl); err != nil {
		return nil, fmt.Errorf("put metadata: %w", err)
	}
	return &PutResponse{
		Name: name,
		Ttl:  ttl,
	}, nil
}

func normalizeCidToV1(cidString string) (string, error) {
	requestCid, err := cid.Decode(cidString)
	if err != nil {
		return "", status.Errorf(
			codes.InvalidArgument,
			"decode cid: %v",
			err,
		)
	}
	codec := requestCid.Prefix().Codec
	if requestCid.Version() == 1 && (codec != cid.Raw && codec != cid.DagProtobuf) {
		return "", status.Errorf(
			codes.InvalidArgument,
			"currently only raw codec (%d) and dag-pb (%d) are accepted but got %d",
			cid.Raw,
			cid.DagProtobuf,
			codec,
		)
	}
	cidV1 := cid.NewCidV1(codec, requestCid.Hash())
	return cidV1.String(), nil
}

// ensurePermissionAndNormalizeKey checks authz.
// write=true requires write permission (owner for named modes; anyone for CONTENT_ADDRESSED).
func (s *ProtectedKvStore) ensurePermissionAndNormalizeKey(ctx context.Context, owner, rawKey string, write bool) (string, error) {
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return "", fmt.Errorf("get session: %w", err)
	}
	var key string
	if owner == PublicUserName {
		key, err = normalizeCidToV1(rawKey)
		if err != nil {
			return "", fmt.Errorf("content-addressed storage must follow cid: %w", err)
		}
	} else {
		key = rawKey
	}
	md, err := s.getValueMetadata(ctx, owner, key)
	if err != nil {
		return "", fmt.Errorf("get metadata: %w", err)
	}
	mode := md.GetAuthorizationMode()
	switch mode {
	case pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED:
		return utils.FormatProtectedName(owner, key), nil
	case pb.AuthorizationMode_AUTHORIZATION_MODE_SELF_READ:
		if session.UserId != owner {
			return "", fmt.Errorf("unauthorized")
		}
		return utils.FormatProtectedName(owner, key), nil
	case pb.AuthorizationMode_AUTHORIZATION_MODE_PUBLIC_READ:
		if write && session.UserId != owner {
			return "", fmt.Errorf("unauthorized")
		}
		return utils.FormatProtectedName(owner, key), nil
	case pb.AuthorizationMode_AUTHORIZATION_MODE_ACL:
		return "", fmt.Errorf("acl mode not implemented yet")
	default:
		return "", fmt.Errorf("unrecognized mode %d", mode)
	}
}

func (s *ProtectedKvStore) getValueMetadata(ctx context.Context, owner, key string) (*pb.ValueMetadata, error) {
	if owner == PublicUserName {
		return &pb.ValueMetadata{
			AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED,
		}, nil
	}

	metadataBytes, err := s.metadataStore.Get(ctx, utils.FormatProtectedMetadataName(owner, key))
	if err != nil {
		return nil, fmt.Errorf("get store: %w", err)
	}
	md := &pb.ValueMetadata{}
	if err := proto.Unmarshal(metadataBytes, md); err != nil {
		return nil, fmt.Errorf("unmarshal metadata: %w", err)
	}
	return md, nil
}

func (s *ProtectedKvStore) Get(ctx context.Context, owner, rawKey string) ([]byte, error) {
	key, err := s.ensurePermissionAndNormalizeKey(ctx, owner, rawKey, false)
	if err != nil {
		return nil, fmt.Errorf("permission error: %w", err)
	}
	return s.store.Get(ctx, key)
}

func (s *ProtectedKvStore) GetStream(ctx context.Context, owner, rawKey string) (io.ReadCloser, error) {
	key, err := s.ensurePermissionAndNormalizeKey(ctx, owner, rawKey, false)
	if err != nil {
		return nil, fmt.Errorf("permission error: %w", err)
	}
	return s.store.GetStream(ctx, key)
}

func (s *ProtectedKvStore) ExtendTtl(ctx context.Context, owner, rawKey string, ttl time.Duration) error {
	key, err := s.ensurePermissionAndNormalizeKey(ctx, owner, rawKey, true)
	if err != nil {
		return fmt.Errorf("permission error: %w", err)
	}
	return s.store.ExtendTtl(ctx, key, ttl)
}

func (s *ProtectedKvStore) GetTtl(ctx context.Context, owner, rawKey string) (*time.Duration, error) {
	key, err := s.ensurePermissionAndNormalizeKey(ctx, owner, rawKey, false)
	if err != nil {
		return nil, fmt.Errorf("permission error: %w", err)
	}
	return s.store.GetTtl(ctx, key)
}

func NormalizeCID(cidString string) (string, error) {
	return normalizeCidToV1(cidString)
}

func (s *ProtectedKvStore) GetRaw(ctx context.Context, key string) ([]byte, error) {
	return s.store.Get(ctx, key)
}

func (s *ProtectedKvStore) PutRaw(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return s.store.Put(ctx, key, value, ttl)
}

func (s *ProtectedKvStore) ReplaceRaw(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if err := s.store.Rename(ctx, key, "tmp-"+key); err != nil {
		return err
	}
	if err := s.store.Put(ctx, key, value, ttl); err != nil {
		return err
	}
	return s.store.Rename(ctx, "tmp-"+key, "old-"+key)
}
