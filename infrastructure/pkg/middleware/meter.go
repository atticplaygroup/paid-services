package middleware

import (
	"context"
	"fmt"
	"log"
	"sync"

	"connectrpc.com/connect"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	kvstorepb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type MeterKey struct{}

type Meter struct {
	mu    sync.Mutex
	Meter *pb.Meter
}

func WithMeter(ctx context.Context, m *Meter) context.Context {
	return context.WithValue(ctx, MeterKey{}, m)
}

func NewMeter(userID string) *Meter {
	return &Meter{
		Meter: &pb.Meter{UserId: userID},
	}
}

func MeterFromContext(ctx context.Context) (*Meter, error) {
	meter, ok := ctx.Value(MeterKey{}).(*Meter)
	if !ok {
		return nil, fmt.Errorf("meter not initialized")
	}
	return meter, nil
}

func (m *Meter) IncrGetCountBy(size int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.GetCount += size
}

func (m *Meter) IncrSetCountBy(size int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.SetCount += size
}

func (m *Meter) IncrGetCount() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.GetCount += 1
}

func (m *Meter) IncrSetCount() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.SetCount += 1
}

func (m *Meter) IncrTempMemoryBytes(size int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.TempMemoryBytes += size
}

func (m *Meter) IncrStorageByteSeconds(size int64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.Meter.StorageByteSeconds += size
}

func getStorageBackend(ar connect.AnyRequest) (kvstorepb.StorageBackend, bool) {
	switch ar.Spec().Procedure {
	case "/kvstore.v1.MeteredStorageService/GetCASValue":
		return kvstorepb.StorageBackend_STORAGE_BACKEND_BLOB_STORAGE, true
	case "/kvstore.v1.MeteredStorageService/CreateCASValue":
		msg, ok := ar.Any().(*kvstorepb.CreateCASValueRequest)
		if ok {
			return msg.GetStorageBackend(), true
		}
		return 0, false
	case "/kvstore.v1.MeteredStorageService/ProlongValue":
		msg, ok := ar.Any().(*kvstorepb.ProlongValueRequest)
		if ok {
			return msg.GetStorageBackend(), true
		}
		return 0, false
	}
	return 0, false
}

func NewReportUsageInterceptor(billingServiceAddress string) connect.UnaryInterceptorFunc {
	grpcOptions := grpc.DialOption(grpc.WithTransportCredentials(insecure.NewCredentials()))
	grpcConn, err := grpc.NewClient(billingServiceAddress, grpcOptions)
	if err != nil {
		log.Fatal("cannot dial grpc remote")
	}
	client := pb.NewDeductionServiceClient(grpcConn)

	interceptor := func(next connect.UnaryFunc) connect.UnaryFunc {
		return connect.UnaryFunc(func(ctx context.Context, ar connect.AnyRequest) (connect.AnyResponse, error) {
			backend, ok := getStorageBackend(ar)
			if !ok {
				return next(ctx, ar)
			}
			session, err := SessionFromContext(ctx)
			if err != nil {
				// Unauthenticated. Set a default meter so downstream
				// operations (e.g. S3Store Put/Get) can proceed.
				ctx = WithMeter(ctx, &Meter{
					mu: sync.Mutex{},
					Meter: &pb.Meter{
						UserId:         "anonymous",
						RequestId:      "anonymous",
						StorageBackend: backend,
					},
				})
				return next(ctx, ar)
			}
			ctx = WithMeter(ctx, &Meter{
				mu: sync.Mutex{},
				Meter: &pb.Meter{
					UserId:         session.UserId,
					RequestId:      session.RequestId,
					StorageBackend: backend,
				},
			})
			ret, callErr := next(ctx, ar)
			meter, err := MeterFromContext(ctx)
			if err != nil {
				return nil, fmt.Errorf("report usage get meter: %w", err)
			}
			if _, reportErr := client.ReportUsage(ctx, &pb.ReportUsageRequest{
				UserId:    meter.Meter.GetUserId(),
				RequestId: meter.Meter.GetRequestId(),
				Usage:     formatUsage(meter.Meter),
			}); reportErr != nil {
				log.Printf("report usage: %s", reportErr.Error())
			}
			return ret, callErr
		})
	}
	return connect.UnaryInterceptorFunc(interceptor)
}

func formatUsage(m *pb.Meter) []*pb.Usage {
	ret := make([]*pb.Usage, 0)
	if m.GetGetCount() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_GET.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetGetCount(),
		})
	}
	if m.GetSetCount() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_SET.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetSetCount(),
		})
	}
	if m.GetTempMemoryBytes() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_PEAK_MEMORY_BYTES.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetTempMemoryBytes(),
		})
	}
	if m.GetDuration().AsDuration() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_DURATION_MS.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetDuration().AsDuration().Milliseconds(),
		})
	}
	if m.GetEgressBytes() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_EGRESS_BYTES.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetEgressBytes(),
		})
	}
	if m.GetIngressBytes() > 0 {
		ret = append(ret, &pb.Usage{
			MeterType:      *pb.Usage_METER_TYPE_INGRESS_BYTES.Enum(),
			StorageBackend: m.GetStorageBackend(),
			UnitCount:      m.GetIngressBytes(),
		})
	}
	return ret
}
