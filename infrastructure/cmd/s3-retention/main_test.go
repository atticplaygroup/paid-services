package main

import (
	"context"
	"reflect"
	"testing"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

type bucketPolicyOnlyClient struct {
	config               *lifecycle.Configuration
	reads, writes        int
	getErr, errorOnWrite error
}

func (c *bucketPolicyOnlyClient) GetBucketLifecycle(context.Context, string) (*lifecycle.Configuration, error) {
	c.reads++
	if c.getErr != nil {
		return nil, c.getErr
	}
	if c.config == nil {
		return nil, minio.ErrorResponse{Code: "NoSuchLifecycleConfiguration"}
	}
	return c.config, nil
}
func (c *bucketPolicyOnlyClient) SetBucketLifecycle(_ context.Context, _ string, config *lifecycle.Configuration) error {
	c.writes++
	if c.errorOnWrite != nil {
		return c.errorOnWrite
	}
	c.config = config
	return nil
}

func TestReconcileMissingPolicyAndNoop(t *testing.T) {
	c := &bucketPolicyOnlyClient{}
	changed, err := reconcile(context.Background(), c, "bucket", []int{10, 20, 10})
	if err != nil || !changed {
		t.Fatalf("changed=%v error=%v", changed, err)
	}
	if c.reads != 1 || c.writes != 1 || len(c.config.Rules) != 2 {
		t.Fatalf("reads=%d writes=%d config=%+v", c.reads, c.writes, c.config)
	}
	for i, day := range []int{10, 20} {
		rule := c.config.Rules[i]
		if rule.Status != "Enabled" || rule.RuleFilter.Tag.Key != "retention" || int(rule.Expiration.Days) != day {
			t.Fatalf("invalid rule: %+v", rule)
		}
	}
	changed, err = reconcile(context.Background(), c, "bucket", []int{20, 10})
	if err != nil || changed || c.reads != 2 || c.writes != 1 {
		t.Fatalf("second run changed=%v error=%v reads=%d writes=%d", changed, err, c.reads, c.writes)
	}
}

func TestReconcileRepairsAndPreservesUnrelatedPolicies(t *testing.T) {
	unrelated := lifecycle.Rule{ID: "archive", Status: "Enabled", RuleFilter: lifecycle.Filter{Prefix: "logs/"}, Expiration: lifecycle.Expiration{Days: 90}}
	c := &bucketPolicyOnlyClient{config: &lifecycle.Configuration{Rules: []lifecycle.Rule{unrelated, {ID: "paid-retention-10", Status: "Disabled"}, {ID: "paid-retention-30"}}}}
	changed, err := reconcile(context.Background(), c, "bucket", []int{10, 20})
	if err != nil || !changed {
		t.Fatalf("changed=%v error=%v", changed, err)
	}
	if len(c.config.Rules) != 3 || !reflect.DeepEqual(c.config.Rules[0], unrelated) {
		t.Fatalf("unrelated policy changed: %+v", c.config)
	}
	for _, rule := range c.config.Rules[1:] {
		if rule.ID == "paid-retention-30" || rule.Status != "Enabled" || rule.Expiration.Days == 0 {
			t.Fatalf("invalid repaired rule: %+v", rule)
		}
	}
	changed, err = reconcile(context.Background(), c, "bucket", []int{10, 20})
	if err != nil || changed || c.writes != 1 {
		t.Fatalf("second run changed=%v error=%v writes=%d", changed, err, c.writes)
	}
}

func TestReconcileRejectsInvalidRangesAndLimits(t *testing.T) {
	tooMany := make([]int, 1001)
	for i := range tooMany {
		tooMany[i] = i + 1
	}
	for _, days := range [][]int{nil, {0}, {-1}, tooMany} {
		c := &bucketPolicyOnlyClient{}
		if _, err := reconcile(context.Background(), c, "bucket", days); err == nil {
			t.Fatalf("accepted invalid durations: %v", days)
		}
		if c.reads != 0 || c.writes != 0 {
			t.Fatal("invalid input accessed backend")
		}
	}
	c := &bucketPolicyOnlyClient{config: &lifecycle.Configuration{Rules: []lifecycle.Rule{{ID: "unrelated"}}}}
	if _, err := reconcile(context.Background(), c, "bucket", tooMany[:1000]); err == nil || c.writes != 0 {
		t.Fatal("combined rule limit was not enforced")
	}
}

func TestReconcilePropagatesAccessErrors(t *testing.T) {
	c := &bucketPolicyOnlyClient{getErr: minio.ErrorResponse{Code: "AccessDenied"}}
	if _, err := reconcile(context.Background(), c, "bucket", []int{10}); err == nil || c.writes != 0 {
		t.Fatal("access error was treated as missing policy")
	}
	c = &bucketPolicyOnlyClient{errorOnWrite: minio.ErrorResponse{Code: "AccessDenied"}}
	if _, err := reconcile(context.Background(), c, "bucket", []int{10}); err == nil {
		t.Fatal("write error was ignored")
	}
}
