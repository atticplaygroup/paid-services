package server

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
)

type withdrawalStatusClient struct {
	fakePaymentClient
	statuses     map[string]exchange.TransactionStatus
	failedDigest string
}

func (client *withdrawalStatusClient) CheckTransactionStatus(_ context.Context, digest string) (exchange.TransactionStatus, error) {
	if digest == client.failedDigest {
		return 0, fmt.Errorf("chain unavailable")
	}
	return client.statuses[digest], nil
}

func TestBatchMarkWithdrawsReturnsSuccessfulBatches(t *testing.T) {
	storeInstance := setupExchangeStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	digests := []string{strings.Repeat("1", 43), strings.Repeat("2", 43), strings.Repeat("3", 43), strings.Repeat("4", 43)}
	batchIDs := make([]int64, len(digests))
	for index, digest := range digests {
		batch, err := storeInstance.SetWithdrawalBatch(ctx, db.SetWithdrawalBatchParams{
			TransactionDigest:      digest,
			TransactionBcsTypeName: "transaction",
			TransactionBcsBytes:    []byte{byte(index)},
			TotalPriorityFee:       3_000_000,
		})
		if err != nil {
			t.Fatalf("create batch: %v", err)
		}
		batchIDs[index] = batch.ProcessingWithdrawalID
	}
	server := &Server{
		config: &exchange.Config{WithdrawCheckStatusCount: 4},
		store:  storeInstance,
		paymentClient: &withdrawalStatusClient{
			statuses: map[string]exchange.TransactionStatus{
				digests[0]: exchange.SUCCESS,
				digests[1]: exchange.SUCCESS,
				digests[2]: exchange.PENDING,
			},
			failedDigest: digests[3],
		},
	}
	type result struct {
		response *connect.Response[pb.BatchMarkWithdrawsResponse]
		err      error
	}
	done := make(chan result, 1)
	go func() {
		response, err := server.BatchMarkWithdraws(ctx, connect.NewRequest(&pb.BatchMarkWithdrawsRequest{Limit: 4}))
		done <- result{response: response, err: err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("BatchMarkWithdraws: %v", got.err)
		}
		ids := got.response.Msg.GetSuccessWithdrawIds()
		slices.Sort(ids)
		if !slices.Equal(ids, batchIDs[:2]) {
			t.Fatalf("successful batch IDs=%v want %v", ids, batchIDs[:2])
		}
	case <-ctx.Done():
		t.Fatal("BatchMarkWithdraws did not return after checking successful batches")
	}
	for index, digest := range digests {
		var status string
		if err := storeInstance.GetConn().QueryRow(ctx,
			"SELECT withdrawal_status FROM processing_withdrawals WHERE transaction_digest = $1", digest).Scan(&status); err != nil {
			t.Fatalf("read batch status: %v", err)
		}
		want := "processing"
		if index < 2 {
			want = "succeeded"
		}
		if status != want {
			t.Errorf("batch %d status=%s want %s", batchIDs[index], status, want)
		}
	}
}
