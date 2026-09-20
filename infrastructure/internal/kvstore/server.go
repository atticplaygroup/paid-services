package kvstore

import (
	"context"
	"fmt"
	"log"
	"time"

	"buf.build/go/protovalidate"
	"connectrpc.com/connect"
	store "github.com/atticplaygroup/paid-services/infrastructure/internal/kvstore/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"
)

type Server struct {
	pb.UnimplementedMeteredStorageServiceServer
	config         *Config
	redisStore     *store.ProtectedKvStore
	s3Store        *store.ProtectedKvStore
	ProtoValidator protovalidate.Validator
}

func (s *Server) GetProtectedStore(backend pb.StorageBackend) (*store.ProtectedKvStore, bool) {
	switch backend {
	case pb.StorageBackend_STORAGE_BACKEND_REDIS:
		if s.redisStore == nil {
			return nil, false
		}
		return s.redisStore, true
	case pb.StorageBackend_STORAGE_BACKEND_BLOB_STORAGE:
		if s.s3Store == nil {
			return nil, false
		}
		return s.s3Store, true
	default:
		return nil, false
	}
}

func NewServer(conf *Config) (*Server, error) {
	redisAddress := fmt.Sprintf("%s:%d", conf.RedisHost, conf.RedisPort)
	redisBackend, redisErr := store.NewRedisStore(redisAddress)
	if redisErr != nil {
		return nil, fmt.Errorf("create redis store: %w", redisErr)
	}
	redisStore := store.NewProtectedKvStore(redisBackend, redisBackend)
	var s3Protected *store.ProtectedKvStore
	if conf.MinioEndpoint != "" && conf.MinioAccessKey != "" {
		s3 := store.NewS3Store(store.NewS3Config(
			conf.MinioEndpoint,
			conf.MinioAccessKey,
			conf.MinioSecretKey,
			conf.MinioBucket,
			true, // in-cluster MinIO is HTTP
		))
		var ensureErr error
		for attempt := 1; attempt <= 20; attempt++ {
			ensureErr = s3.EnsureBucket(context.Background())
			if ensureErr == nil {
				break
			}
			log.Printf("ensure minio bucket (attempt %d): %v", attempt, ensureErr)
			time.Sleep(time.Second)
		}
		if ensureErr != nil {
			return nil, fmt.Errorf("ensure minio bucket %q: %w", conf.MinioBucket, ensureErr)
		}
		// Metadata in mem for now; object body in S3.
		// TODO: CAS first-byte path sharding for S3 object keys.
		s3Protected = store.NewProtectedKvStore(s3, store.NewMemStore())
		log.Printf("s3 backend enabled endpoint=%s bucket=%s", conf.MinioEndpoint, conf.MinioBucket)
	} else {
		log.Printf("s3 backend disabled (set MINIO_ENDPOINT and MINIO_ACCESS_KEY)")
	}
	validator, err := protovalidate.New()
	if err != nil {
		log.Fatalf("initialize protovalidator: %v", err)
	}
	server := Server{
		config:         conf,
		redisStore:     redisStore,
		s3Store:        s3Protected,
		ProtoValidator: validator,
	}
	return &server, nil
}

func (s *Server) Ping(
	ctx context.Context,
	connectReq *connect.Request[pb.PingRequest],
) (*connect.Response[pb.PingResponse], error) {
	return connect.NewResponse(&pb.PingResponse{
		Pong: "pong",
	}), nil
}

func (s *Server) CreateCASValue(
	ctx context.Context, connectReq *connect.Request[pb.CreateCASValueRequest],
) (*connect.Response[pb.CreateCASValueResponse], error) {
	req := connectReq.Msg
	backend, ok := s.GetProtectedStore(req.GetStorageBackend())
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "backend %s not supported", req.GetStorageBackend().String())
	}
	md := &pb.ValueMetadata{
		AuthorizationMode: pb.AuthorizationMode_AUTHORIZATION_MODE_CONTENT_ADDRESSED,
		Codec:             req.GetCodec(),
	}
	putResponse, err := backend.Put(ctx, md, req.GetKey(), req.GetValue(), req.GetTtl().AsDuration())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "create CAS value: %v", err)
	}
	return connect.NewResponse(&pb.CreateCASValueResponse{
		Name: putResponse.Name,
		Ttl:  durationpb.New(putResponse.Ttl),
	}), nil
}

func (s *Server) GetCASValue(
	ctx context.Context, connectReq *connect.Request[pb.GetCASValueRequest],
) (*connect.Response[pb.GetCASValueResponse], error) {
	req := connectReq.Msg
	if session, sessionErr := middleware.SessionFromContext(ctx); sessionErr == nil {
		ctx = middleware.WithMeter(ctx, middleware.NewMeter(session.UserId))
	}
	backend, ok := s.GetProtectedStore(pb.StorageBackend_STORAGE_BACKEND_BLOB_STORAGE)
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "CAS backend not supported")
	}
	key, err := store.NormalizeCID(req.GetKey())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "CAS key: %v", err)
	}
	value, err := backend.Get(ctx, store.PublicUserName, key)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "CAS value not found: %s", key)
	}
	return connect.NewResponse(&pb.GetCASValueResponse{Value: value}), nil
}

func (s *Server) CreateProtectedValueAnchor(
	ctx context.Context, connectReq *connect.Request[pb.CreateProtectedValueAnchorRequest],
) (*connect.Response[pb.CreateProtectedValueAnchorResponse], error) {
	req := connectReq.Msg
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Error(codes.Unauthenticated, "get session")
	}
	anchor := req.GetAnchor()
	ctx = middleware.WithMeter(middleware.WithSession(ctx, session), middleware.NewMeter(session.UserId))
	if err := store.VerifyAnchor(ctx, anchor, session.UserId); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "verify anchor: %v", err)
	}
	if err := store.PutAnchor(ctx, s.redisStore, anchor, 365*24*time.Hour); err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "store anchor: %v", err)
	}
	return connect.NewResponse(&pb.CreateProtectedValueAnchorResponse{Anchor: anchor}), nil
}

func (s *Server) GetProtectedValueAnchor(
	ctx context.Context, connectReq *connect.Request[pb.GetProtectedValueAnchorRequest],
) (*connect.Response[pb.GetProtectedValueAnchorResponse], error) {
	req := connectReq.Msg
	if session, sessionErr := middleware.SessionFromContext(ctx); sessionErr == nil {
		ctx = middleware.WithMeter(ctx, middleware.NewMeter(session.UserId))
	}
	anchor, getErr := store.GetAnchor(ctx, s.redisStore, req.GetOwner(), req.GetKey())
	if getErr != nil {
		return nil, status.Errorf(codes.NotFound, "anchor not found: %v", getErr)
	}
	return connect.NewResponse(&pb.GetProtectedValueAnchorResponse{Anchor: anchor}), nil
}

func (s *Server) ProlongValue(
	ctx context.Context, connectReq *connect.Request[pb.ProlongValueRequest],
) (*connect.Response[pb.ProlongValueResponse], error) {
	req := connectReq.Msg
	store, ok := s.GetProtectedStore(req.GetStorageBackend())
	if !ok {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"backend %s not supported",
			req.GetStorageBackend().String(),
		)
	}
	if err := store.ExtendTtl(ctx, req.GetOwner(), req.GetKey(), req.GetTtl().AsDuration()); err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"set ttl: %v",
			err,
		)
	}
	if newTtl, err := store.GetTtl(ctx, req.GetOwner(), req.GetKey()); err != nil {
		return nil, status.Errorf(
			codes.Internal,
			"get new ttl: %v",
			err,
		)
	} else {
		return connect.NewResponse(&pb.ProlongValueResponse{
			Owner: req.GetOwner(),
			Key:   req.GetKey(),
			Ttl:   durationpb.New(*newTtl),
		}), nil
	}
}
