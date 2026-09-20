package als

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/account/v1"
	kvstorepb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
	utils "github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
)

func setupBalanceBackendTest(t *testing.T) (*Server, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)

	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	srv, err := New(Config{
		RedisAddress:   mr.Addr(),
		BalanceBackend: "redis",
	})
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	return srv, mr
}

func TestReportUsageDeductsRedisBalance(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	userKey := utils.AuthzKey(principal)
	if err := mr.Set(userKey, "100"); err != nil {
		t.Fatalf("seed balance: %v", err)
	}
	serviceKey := "p:3:1"
	mr.HSet(serviceKey, "METER_TYPE_SET", "2")
	if got := mr.HGet(serviceKey, "METER_TYPE_SET"); got != "2" {
		t.Fatalf("seeded price=%q want 2", got)
	}

	req := connect.NewRequest(&pb.ReportUsageRequest{
		UserId: principal,
		Usage: []*pb.Usage{{
			MeterType:      pb.Usage_METER_TYPE_SET,
			UnitCount:      10,
			StorageBackend: kvstorepb.StorageBackend_STORAGE_BACKEND_REDIS,
		}},
	})
	resp, err := srv.ReportUsage(context.Background(), req)
	if err != nil {
		t.Fatalf("ReportUsage: %v", err)
	}
	if resp.Msg == nil {
		t.Fatal("expected response message")
	}

	balance, err := mr.Get(userKey)
	if err != nil {
		t.Fatalf("read balance: %v", err)
	}
	if balance != "-1999900" {
		t.Fatalf("balance=%q want -1999900", balance)
	}
}

func TestReportUsageRejectsNegativeBalanceWithoutClamping(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	principal := "dpop-principal"
	if err := mr.Set(utils.AuthzKey(principal), "0"); err != nil {
		t.Fatalf("seed balance: %v", err)
	}
	mr.HSet("p:3:1", "METER_TYPE_SET", "2")

	req := connect.NewRequest(&pb.ReportUsageRequest{
		UserId: principal,
		Usage: []*pb.Usage{{
			MeterType:      pb.Usage_METER_TYPE_SET,
			UnitCount:      1,
			StorageBackend: kvstorepb.StorageBackend_STORAGE_BACKEND_REDIS,
		}},
	})
	resp, err := srv.ReportUsage(context.Background(), req)
	if err != nil {
		t.Fatalf("ReportUsage: %v", err)
	}
	if resp.Msg == nil {
		t.Fatal("expected response message")
	}

	balance, err := mr.Get(utils.AuthzKey(principal))
	if err != nil {
		t.Fatalf("read balance: %v", err)
	}
	if balance != "-200000" {
		t.Fatalf("balance=%q want -200000", balance)
	}
}
