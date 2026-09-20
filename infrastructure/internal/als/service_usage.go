package als

import (
	"context"
	"errors"
	"fmt"
	"log"

	"connectrpc.com/connect"
	balancepkg "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	kvstorepb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	utils "github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

func formatPriceKey(usage *pb.Usage) string {
	return fmt.Sprintf("p:%d:%d", kvstorepb.ConnectionSource_CONNECTION_SOURCE_INTERNAL, usage.GetStorageBackend())
}

func (s *Server) ReportUsage(ctx context.Context, req *connect.Request[pb.ReportUsageRequest]) (*connect.Response[pb.ReportUsageResponse], error) {
	r := req.Msg
	totalPrice := int64(0)
	for _, usage := range r.GetUsage() {
		key := formatPriceKey(usage)
		unitPrice, err := s.getPrice(ctx, key, usage.GetMeterType().Enum())
		if err != nil {
			log.Printf("report usage get unit price: %v", err)
		}
		price := int64(float64(usage.GetUnitCount())*unitPrice) * utils.INFLATION
		totalPrice += price

		// Store meter feedback if enabled
		if s.feedbackEnabled && r.GetRequestId() != "" {
			s.storeFeedback(ctx, r.GetRequestId(), int32(usage.GetMeterType()), price)
		}
	}
	if _, err := s.balanceStore.Deduct(ctx, r.GetUserId(), totalPrice); err != nil {
		if errors.Is(err, balancepkg.ErrNotFound) {
			return nil, fmt.Errorf("account not found: %w", err)
		}
		return nil, fmt.Errorf("deduct balance: %w", err)
	}
	return connect.NewResponse(&pb.ReportUsageResponse{}), nil
}
