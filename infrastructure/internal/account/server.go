package account

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"buf.build/go/protovalidate"
	"connectrpc.com/connect"
	balancebackend "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

type Server struct {
	redisClient    *redis.Client
	balanceStore   balancepkg.Store
	jwtRedeemer    Redeemer
	jwtValidator   *jwtValidator
	ProtoValidator protovalidate.Validator
}

// Package-level vars for coin type/environment (set during NewServer)
var validCoinType int64 = 1
var validCoinEnvironment int64 = 4

func NewServer(conf *Config) (*Server, error) {
	redisAddress := fmt.Sprintf("%s:%d", conf.RedisHost, conf.RedisPort)
	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddress,
	})
	redeemer := NewRedisRedeemer(rdb)
	balanceStore, err := balancebackend.NewStore(
		context.Background(),
		conf.BalanceBackend,
		rdb,
		conf.ExchangeDatabaseURL,
	)
	if err != nil {
		return nil, err
	}
	validator, err := protovalidate.New()
	if err != nil {
		log.Fatalf("initialize protovalidator: %v", err)
	}
	validCoinType = conf.ValidCoinType
	validCoinEnvironment = conf.ValidCoinEnvironment
	jwtValidator, err := newJwtValidator(conf)
	if err != nil {
		log.Fatal(err)
	}
	server := Server{
		redisClient:    rdb,
		balanceStore:   balanceStore,
		jwtRedeemer:    redeemer,
		jwtValidator:   jwtValidator,
		ProtoValidator: validator,
	}
	if conf.RedeemExchangeTokens {
		jwtValidator.redeemer = redeemer
	}
	return &server, nil
}

func (s *Server) GetAccount(ctx context.Context, req *connect.Request[pb.GetAccountRequest]) (
	*connect.Response[pb.GetAccountResponse], error,
) {
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"invalid session: %v",
			err,
		)
	}
	balance, err := s.balanceStore.Get(ctx, session.UserId)
	if err != nil {
		log.Printf("get balance failed: principal=%q err=%v", session.UserId, err)
		if errors.Is(err, balancepkg.ErrNotFound) {
			return nil, status.Errorf(codes.PermissionDenied, "account not found: %v", err)
		}
		return nil, status.Errorf(codes.Internal, "fetch balance: %v", err)
	}
	return connect.NewResponse(&pb.GetAccountResponse{
		Account: &pb.Account{
			AccountId:  session.UserId,
			Balance:    balance,
			ExpireTime: timestamppb.New(time.Now().Add(utils.AccountDefaultTtl)),
		},
	}), nil
}

func (s *Server) DepositOrCreateAccount(ctx context.Context, req *connect.Request[pb.DepositOrCreateAccountRequest]) (
	*connect.Response[pb.DepositOrCreateAccountResponse], error,
) {
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"invalid session: %v",
			err,
		)
	}
	// FIXME: Nullify used JWT otherwise vulnerable to replay attacks.
	quantity, err := s.jwtValidator.validate(ctx, req.Msg.GetJwt())
	if err != nil {
		return nil, status.Errorf(
			codes.InvalidArgument,
			"exchange token validation: %v",
			err,
		)
	}
	balanceValue, err := s.balanceStore.Increment(ctx, session.UserId, quantity)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "increase balance: %v", err)
	}
	return connect.NewResponse(&pb.DepositOrCreateAccountResponse{
		Account: &pb.Account{
			AccountId: session.UserId,
			Balance:   balanceValue,
		},
	}), nil
}

func (s *Server) GetBalance(ctx context.Context, req *connect.Request[pb.GetBalanceRequest]) (
	*connect.Response[pb.GetBalanceResponse], error,
) {
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, status.Errorf(
			codes.PermissionDenied,
			"invalid session: %v",
			err,
		)
	}
	balance, err := s.balanceStore.Get(ctx, session.UserId)
	if err != nil {
		if errors.Is(err, balancepkg.ErrNotFound) {
			return nil, status.Errorf(codes.PermissionDenied, "account not found: %v", err)
		}
		return nil, status.Errorf(codes.Internal, "fetch balance: %v", err)
	}
	return connect.NewResponse(&pb.GetBalanceResponse{
		Balance: balance,
	}), nil
}

func (s *Server) GetMeterFeedback(ctx context.Context, req *connect.Request[pb.GetMeterFeedbackRequest]) (
	*connect.Response[pb.GetMeterFeedbackResponse], error,
) {
	externalRequestID := req.Msg.GetExternalRequestId()
	key := fmt.Sprintf("feedback:%s", externalRequestID)

	// HGETALL returns all meter type → price fields
	result, err := s.redisClient.HGetAll(ctx, key).Result()
	if err != nil {
		return nil, status.Errorf(codes.Internal, "hgetall: %v", err)
	}

	details := make(map[int32]int64)
	totalPrice := int64(0)
	for meterTypeStr, priceStr := range result {
		meterType, err := strconv.Atoi(meterTypeStr)
		if err != nil {
			continue
		}
		price, err := strconv.ParseInt(priceStr, 10, 64)
		if err != nil {
			continue
		}
		details[int32(meterType)] = price
		totalPrice += price
	}

	// Get coin type and environment from config
	coinType := int32(validCoinType)
	coinEnv := int32(validCoinEnvironment)

	return connect.NewResponse(&pb.GetMeterFeedbackResponse{
		Feedback: &pb.MeterFeedback{
			CoinType:        coinType,
			CoinEnvironment: coinEnv,
			TotalPrice:      totalPrice,
			Details:         details,
		},
	}), nil
}
