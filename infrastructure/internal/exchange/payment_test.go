package exchange

import (
	"context"
	"net"
	"strings"
	"testing"

	"github.com/block-vision/sui-go-sdk/common/grpcconn"
	v2 "github.com/block-vision/sui-go-sdk/pb/sui/rpc/v2"
	"github.com/block-vision/sui-go-sdk/signer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

type depositEpochGetter struct{}

func (depositEpochGetter) GetCurrentEpoch(context.Context) (*v2.Epoch, error) {
	return &v2.Epoch{Epoch: proto.Uint64(10)}, nil
}

func validDeposit() *v2.ExecutedTransaction {
	return &v2.ExecutedTransaction{
		Digest:         proto.String("digest"),
		Transaction:    &v2.Transaction{Sender: proto.String("0xsender")},
		Effects:        &v2.TransactionEffects{Epoch: proto.Uint64(10), Status: &v2.ExecutionStatus{Success: proto.Bool(true)}},
		BalanceChanges: []*v2.BalanceChange{{Address: proto.String("0xexchange"), CoinType: proto.String("0x2::sui::SUI"), Amount: proto.String("100000000")}},
	}
}

func TestCheckTransaction(t *testing.T) {
	for _, tt := range []struct {
		name       string
		mutate     func(*v2.ExecutedTransaction)
		wantErr    string
		wantAmount int64
	}{
		{name: "valid", wantAmount: 100000000},
		{name: "padded coin type", mutate: func(tx *v2.ExecutedTransaction) {
			tx.BalanceChanges[0].CoinType = proto.String("0x" + strings.Repeat("0", 63) + "2::sui::SUI")
		}, wantAmount: 100000000},
		{name: "sum net SUI changes", mutate: func(tx *v2.ExecutedTransaction) {
			change := proto.Clone(tx.BalanceChanges[0]).(*v2.BalanceChange)
			change.Amount = proto.String("-1")
			tx.BalanceChanges = append(tx.BalanceChanges, change)
		}, wantAmount: 99999999},
		{name: "digest mismatch", mutate: func(tx *v2.ExecutedTransaction) { tx.Digest = proto.String("other") }, wantErr: "no transaction"},
		{name: "missing sender", mutate: func(tx *v2.ExecutedTransaction) { tx.Transaction = nil }, wantErr: "no transaction"},
		{name: "failed", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects.Status.Success = proto.Bool(false) }, wantErr: "did not succeed"},
		{name: "missing effects", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects = nil }, wantErr: "did not succeed"},
		{name: "missing epoch", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects.Epoch = nil }, wantErr: "did not succeed"},
		{name: "expired", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects.Epoch = proto.Uint64(7) }, wantErr: "too late"},
		{name: "epoch boundary", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects.Epoch = proto.Uint64(8) }, wantAmount: 100000000},
		{name: "future epoch", mutate: func(tx *v2.ExecutedTransaction) { tx.Effects.Epoch = proto.Uint64(11) }, wantErr: "too late"},
		{name: "wrong recipient", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].Address = proto.String("0xother") }, wantErr: "invalid SUI"},
		{name: "wrong coin", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].CoinType = proto.String("0x3::sui::SUI") }, wantErr: "invalid SUI"},
		{name: "malformed amount", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].Amount = proto.String("abc") }, wantErr: "parse deposit"},
		{name: "overflow", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].Amount = proto.String("9223372036854775808") }, wantErr: "invalid SUI"},
		{name: "negative", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].Amount = proto.String("-1") }, wantErr: "invalid SUI"},
		{name: "zero", mutate: func(tx *v2.ExecutedTransaction) { tx.BalanceChanges[0].Amount = proto.String("0") }, wantErr: "invalid SUI"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tx := validDeposit()
			if tt.mutate != nil {
				tt.mutate(tx)
			}
			deposit, err := checkTransaction(tx, "digest", "0xexchange", 10, 2)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("got %v, want %s", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if deposit.Amount != tt.wantAmount || deposit.Address != "0xsender" || deposit.Epoch != int64(tx.GetEffects().GetEpoch()) {
				t.Fatalf("unexpected deposit: %+v", deposit)
			}
		})
	}
}

type depositLedger struct {
	v2.UnimplementedLedgerServiceServer
	t *testing.T
}

func (s *depositLedger) GetTransaction(ctx context.Context, req *v2.GetTransactionRequest) (*v2.GetTransactionResponse, error) {
	if req.GetDigest() == "missing" {
		return nil, status.Error(codes.NotFound, "transaction not found")
	}
	expected := []string{"digest", "transaction.sender", "effects.status", "effects.epoch", "balance_changes"}
	if strings.Join(req.GetReadMask().GetPaths(), ",") != strings.Join(expected, ",") {
		s.t.Errorf("unexpected read mask: %v", req.GetReadMask())
	}
	return &v2.GetTransactionResponse{Transaction: validDeposit()}, nil
}

// This is a mock GRPC server. The real SUI call is tested in the e2e-cashier test, where the cashier with empty balance will call Deposit().
func TestCheckDepositGRPC(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	v2.RegisterLedgerServiceServer(server, &depositLedger{t: t})
	go server.Serve(listener)
	defer server.Stop()
	gc := grpcconn.NewSuiGrpcClient(listener.Addr().String(), grpcconn.WithDialOptions(grpc.WithTransportCredentials(insecure.NewCredentials())))
	defer gc.Close()
	client := &SuiPaymentClient{SuiGrpcClient: gc, Signer: signer.Signer{Address: "0xexchange"}, EpochGetter: depositEpochGetter{}}
	deposit, err := client.CheckDeposit(context.Background(), "digest", 2)
	if err != nil {
		t.Fatal(err)
	}
	if deposit.Amount != 100000000 {
		t.Fatalf("unexpected amount: %d", deposit.Amount)
	}
	_, err = client.CheckDeposit(context.Background(), "missing", 2)
	if status.Code(err) != codes.NotFound {
		t.Fatalf("got %v, want NotFound", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = client.CheckDeposit(ctx, "digest", 2)
	if status.Code(err) != codes.Canceled {
		t.Fatalf("got %v, want Canceled", err)
	}
}
