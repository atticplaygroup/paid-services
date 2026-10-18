package authzhttp

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	balancebackend "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"

	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	authv3 "github.com/envoyproxy/go-control-plane/envoy/service/auth/v3"
	"github.com/redis/go-redis/v9"
	"google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc/codes"
	"google.golang.org/protobuf/types/known/structpb"
)

// Server implements envoy.service.auth.v3.Authorization for DPoP Bearer.
type Server struct {
	authv3.UnimplementedAuthorizationServer

	balanceStore balancepkg.Store
	dpop         *dpop.Verifier

	// allowZeroBalanceHTUs lists RPC paths that are permitted even when the
	// principal has zero balance. DPoP authentication is still required.
	// These are bootstrap endpoints like CreditBalance and DepositOrCreateAccount
	// that create or credit accounts before the principal has funds.
	allowZeroBalanceHTUs []string
}

const HeaderUserId = "x-user-id"

const DefaultDPoPMaxAge = dpop.DefaultMaxAge

func New(config Config) (*Server, error) {
	redisClient := redis.NewClient(&redis.Options{Addr: config.RedisAddress})
	balanceStore, err := balancebackend.NewStore(
		context.Background(),
		config.BalanceBackend,
		redisClient,
		config.ExchangeDatabaseURL,
	)
	if err != nil {
		return nil, err
	}
	maxAge := config.MaxAge()
	return &Server{
		balanceStore:         balanceStore,
		dpop:                 dpop.NewVerifier(maxAge),
		allowZeroBalanceHTUs: config.AllowZeroBalanceHTUs,
	}, nil
}

type claim struct {
	Principal string
	HTU       string
}

func (c claim) metadata(decision string, redisKey string) *structpb.Struct {
	fields := map[string]any{
		"principal": c.Principal,
		"htu":       c.HTU,
		"redis_key": redisKey,
		"decision":  decision,
	}
	md, err := structpb.NewStruct(fields)
	if err != nil {
		return nil
	}
	return md
}

// Check implements AuthorizationServer.
func (s *Server) Check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	return s.check(ctx, req)
}

func (s *Server) check(ctx context.Context, req *authv3.CheckRequest) (*authv3.CheckResponse, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	if httpReq != nil {
		headers := httpReq.GetHeaders()
		authHdr := headerGet(headers, "authorization")
		path := httpReq.GetPath()
		log.Printf("CHECK request: path=%s auth_hdr_len=%d has_auth=%v", path, len(authHdr), authHdr != "")
	} else {
		log.Printf("CHECK request: no HTTP request")
	}
	log.Printf("RESOLVING... path=%s", httpReq.GetPath())
	authClaims, err := s.resolve(req)
	if err != nil {
		log.Printf("DENY resolve: %v", err)
		return deny(err.Error(), nil), nil
	}
	log.Printf("ALLOW resolve: principal=%s htu=%s", authClaims.Principal, authClaims.HTU)
	balance, err := s.balanceStore.Get(ctx, authClaims.Principal)
	if errors.Is(err, balancepkg.ErrNotFound) {
		// Unknown accounts get zero balance; bootstrap HTUs can still pass.
		balance = 0
	} else if err != nil {
		md := authClaims.metadata("DENY_GET_BALANCE", "")
		return deny(fmt.Sprintf("balance check failed: %v", err), md), err
	}
	// Allow if balance > 0, or if this HTU is in the allow-zero-balance list
	// (account creation/crediting RPCs like CreditBalance, DepositOrCreateAccount).
	// DPoP auth is still verified above — only the balance check is skipped.
	skipBalanceCheck := isAllowZeroBalance(s.allowZeroBalanceHTUs, authClaims.HTU)
	if balance > 0 || skipBalanceCheck {
		md := authClaims.metadata("ALLOW", "")
		return &authv3.CheckResponse{
			Status:          &status.Status{Code: int32(codes.OK)},
			DynamicMetadata: md,
			HttpResponse: &authv3.CheckResponse_OkResponse{
				OkResponse: &authv3.OkHttpResponse{
					Headers: []*corev3.HeaderValueOption{
						{Header: &corev3.HeaderValue{Key: HeaderUserId, Value: authClaims.Principal}},
					},
				},
			},
		}, nil
	} else {
		// Zero balance and not in allow list — deny.
		md := authClaims.metadata("DENY", "")
		return deny("insufficient balance", md), nil
	}
}

func (s *Server) resolve(req *authv3.CheckRequest) (claim, error) {
	httpReq := req.GetAttributes().GetRequest().GetHttp()
	if httpReq == nil {
		return claim{}, fmt.Errorf("http authz: no HTTP request")
	}
	authzHdr := headerGet(httpReq.GetHeaders(), "authorization")
	scheme := strings.TrimSpace(httpReq.GetScheme())
	if scheme == "" {
		scheme = "https"
	}
	host := strings.TrimSpace(httpReq.GetHost())
	if host == "" {
		host = headerGet(httpReq.GetHeaders(), "host")
	}
	htu, err := dpop.HTU(scheme, host, httpReq.GetPath())
	if err != nil {
		return claim{}, err
	}
	method := strings.TrimSpace(httpReq.GetMethod())
	res, err := s.dpop.VerifyBearer(authzHdr, method, htu)
	if err != nil {
		return claim{}, fmt.Errorf("%w (expected htu %s)", err, htu)
	}
	principal, err := utils.PrincipalFromThumbprint(res.JKTBytes)
	if err != nil {
		return claim{}, fmt.Errorf("transform multiformat: %w", err)
	}
	return claim{Principal: principal.String(), HTU: htu}, nil
}

func deny(msg string, md *structpb.Struct) *authv3.CheckResponse {
	return &authv3.CheckResponse{
		Status: &status.Status{Code: int32(codes.PermissionDenied), Message: msg},
		HttpResponse: &authv3.CheckResponse_DeniedResponse{
			DeniedResponse: &authv3.DeniedHttpResponse{},
		},
		DynamicMetadata: md,
	}
}

func isAllowZeroBalance(list []string, htu string) bool {
	for _, allowed := range list {
		if strings.Contains(htu, allowed) {
			return true
		}
	}
	return false
}

func headerGet(h map[string]string, name string) string {
	if h == nil {
		return ""
	}
	if v, ok := h[name]; ok {
		return v
	}
	lower := strings.ToLower(name)
	for k, v := range h {
		if strings.ToLower(k) == lower {
			return v
		}
	}
	return ""
}
