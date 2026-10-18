package deduction

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"connectrpc.com/connect"
	balancebackend "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1/accountconnect"
	utils "github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	datalogv3 "github.com/envoyproxy/go-control-plane/envoy/data/accesslog/v3"
	alsv3 "github.com/envoyproxy/go-control-plane/envoy/service/accesslog/v3"
	"github.com/redis/go-redis/v9"
)

type Server struct {
	alsv3.UnimplementedAccessLogServiceServer
	pb.UnimplementedDeductionServiceServer
	redisClient  redis.UniversalClient
	balanceStore balancepkg.Store

	// Meter feedback config
	feedbackEnabled bool
	feedbackTTL     time.Duration
	outproxyAddr    string

	// In-memory scheduled deductions
	mu       sync.Mutex
	schedule map[string]scheduledDeduction
}

type scheduledDeduction struct {
	userID              string
	feedbackServiceAddr string
	externalRequestID   string
	delay               time.Duration
}

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
	return &Server{
		redisClient:     redisClient,
		balanceStore:    balanceStore,
		feedbackEnabled: config.MeterFeedbackEnabled,
		feedbackTTL:     config.MeterFeedbackTTL(),
		outproxyAddr:    config.OutproxyAddress,
		schedule:        make(map[string]scheduledDeduction),
	}, nil
}

func (s *Server) StreamAccessLogs(stream alsv3.AccessLogService_StreamAccessLogsServer) error {
	for {
		msg, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&alsv3.StreamAccessLogsResponse{})
		}
		if err != nil {
			return err
		}
		s.handle(msg)
	}
}

func (s *Server) handle(msg *alsv3.StreamAccessLogsMessage) {
	switch entries := msg.GetLogEntries().(type) {
	case *alsv3.StreamAccessLogsMessage_HttpLogs:
		for _, e := range entries.HttpLogs.GetLogEntry() {
			principal := ""
			if id, ok := e.GetCommonProperties().GetCustomTags()["principal"]; ok {
				principal = id
			} else if headers := e.GetRequest().GetRequestHeaders(); headers != nil {
				principal = headers["x-user-id"]
			}
			if principal == "" {
				log.Printf("empty user key principal")
				continue
			}
			key, err := formatDPoPKey(e)
			if err != nil {
				log.Printf("format dpop key: %v", err)
				continue
			}
			// Preserve the external request ID supplied by the upstream outproxy.
			externalRequestID := ""
			if headers := e.GetRequest().GetRequestHeaders(); headers != nil {
				if id, ok := headers["x-external-request-id"]; ok {
					externalRequestID = id
				}
			}
			if err := s.deduct(key, getDPoPEntryIO(e), principal, externalRequestID); err != nil {
				log.Printf("deduct: %v", err)
				continue
			}
		}
	}
}

type entryIO struct {
	DurationMs    float64
	ReceivedBytes float64
	SentBytes     float64
}

func getDPoPEntryIO(e *datalogv3.HTTPAccessLogEntry) *entryIO {
	durationMs := float64(e.GetCommonProperties().GetDuration().AsDuration().Milliseconds())
	req := e.GetRequest()
	ingressBytes := float64(req.GetRequestHeadersBytes() + req.GetRequestBodyBytes())
	resp := e.GetResponse()
	egressBytes := float64(resp.GetResponseHeadersBytes() + resp.GetResponseBodyBytes())
	return &entryIO{
		DurationMs:    durationMs,
		ReceivedBytes: ingressBytes,
		SentBytes:     egressBytes,
	}
}

func formatDPoPKey(e *datalogv3.HTTPAccessLogEntry) (string, error) {
	c := e.GetCommonProperties()
	hostname := c.GetTlsProperties().GetTlsSniHostname()
	port := c.GetDownstreamLocalAddress().GetSocketAddress().GetPortValue()
	path := e.GetRequest().GetPath()
	return fmt.Sprintf("p:%s:%d:%s", hostname, port, path), nil
}

func (s *Server) getPrice(ctx context.Context, serviceId string, field *pb.Usage_MeterType) (float64, error) {
	str, err := s.redisClient.HGet(ctx, serviceId, field.Enum().String()).Result()
	if err != nil {
		return 0, fmt.Errorf("parse %s price: %w", field, err)
	}
	return strconv.ParseFloat(str, 64)
}

func (s *Server) deduct(serviceId string, e *entryIO, principal string, externalRequestID string) error {
	ctx := context.Background()
	durationUnitPrice, err := s.getPrice(ctx, serviceId, pb.Usage_METER_TYPE_DURATION_MS.Enum())
	if err != nil {
		return fmt.Errorf("duration price: %w", err)
	}
	ingressUnitPrice, err := s.getPrice(ctx, serviceId, pb.Usage_METER_TYPE_INGRESS_BYTES.Enum())
	if err != nil {
		return fmt.Errorf("ingress price: %w", err)
	}
	egressUnitPrice, err := s.getPrice(ctx, serviceId, pb.Usage_METER_TYPE_EGRESS_BYTES.Enum())
	if err != nil {
		return fmt.Errorf("egress price: %w", err)
	}
	totalPrice := e.DurationMs*durationUnitPrice + e.ReceivedBytes*ingressUnitPrice + e.SentBytes*egressUnitPrice
	price := int64(totalPrice) * utils.INFLATION

	if _, err := s.balanceStore.Deduct(ctx, principal, price); err != nil {
		if errors.Is(err, balancepkg.ErrNotFound) {
			return fmt.Errorf("account not found: %w", err)
		}
		return fmt.Errorf("deduct balance: %w", err)
	}

	// Store meter feedback if enabled and we have an external request id
	if s.feedbackEnabled && externalRequestID != "" {
		s.storeFeedback(ctx, externalRequestID, int32(pb.Usage_METER_TYPE_DURATION_MS), int64(e.DurationMs*durationUnitPrice)*utils.INFLATION)
		s.storeFeedback(ctx, externalRequestID, int32(pb.Usage_METER_TYPE_INGRESS_BYTES), int64(e.ReceivedBytes*ingressUnitPrice)*utils.INFLATION)
		s.storeFeedback(ctx, externalRequestID, int32(pb.Usage_METER_TYPE_EGRESS_BYTES), int64(e.SentBytes*egressUnitPrice)*utils.INFLATION)
	}

	return nil
}

func (s *Server) storeFeedback(ctx context.Context, externalRequestID string, meterType int32, price int64) {
	key := fmt.Sprintf("feedback:%s", externalRequestID)
	field := strconv.Itoa(int(meterType))
	pipe := s.redisClient.Pipeline()
	pipe.HIncrBy(ctx, key, field, price)
	pipe.Expire(ctx, key, s.feedbackTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		log.Printf("store feedback: %v", err)
	}
}

// ScheduleExternalDeduction implements the DeductionService RPC.
func (s *Server) ScheduleExternalDeduction(ctx context.Context, req *connect.Request[pb.ScheduleExternalDeductionRequest]) (*connect.Response[pb.ScheduleExternalDeductionResponse], error) {
	r := req.Msg
	sd := scheduledDeduction{
		userID:              r.GetUserId(),
		feedbackServiceAddr: r.GetFeedbackServiceAddress(),
		externalRequestID:   r.GetExternalRequestId(),
		delay:               time.Duration(r.DelaySeconds) * time.Second,
	}

	s.mu.Lock()
	s.schedule[r.ExternalRequestId] = sd
	s.mu.Unlock()

	go s.executeExternalDeduction(sd)

	return connect.NewResponse(&pb.ScheduleExternalDeductionResponse{}), nil
}

func (s *Server) executeExternalDeduction(sd scheduledDeduction) {
	time.Sleep(sd.delay)

	httpClient := &http.Client{}
	if s.outproxyAddr != "" {
		// Route through outproxy for the GetMeterFeedback call
		proxyURL, err := url.Parse(s.outproxyAddr)
		if err == nil {
			httpClient.Transport = &http.Transport{
				Proxy: http.ProxyURL(proxyURL),
			}
		}
	}
	client := accountconnect.NewAccountServiceClient(
		httpClient,
		sd.feedbackServiceAddr,
	)
	resp, err := client.GetMeterFeedback(context.Background(), connect.NewRequest(&pb.GetMeterFeedbackRequest{
		ExternalRequestId: sd.externalRequestID,
	}))
	if err != nil {
		log.Printf("external deduction query feedback: %v", err)
		return
	}

	feedback := resp.Msg.Feedback
	if feedback == nil || feedback.TotalPrice <= 0 {
		return
	}

	if _, err := s.balanceStore.Deduct(context.Background(), sd.userID, feedback.TotalPrice); err != nil {
		log.Printf("external deduction decr by: %v", err)
		return
	}

	// Recursive feedback: if this Deduction also has feedback enabled, propagate
	if s.feedbackEnabled {
		for meterTypeInt, price := range feedback.Details {
			s.storeFeedback(context.Background(), sd.externalRequestID, meterTypeInt, price)
		}
	}
}
