// s3-retention is a deployment utility; it never accesses stored objects.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
)

const rulePrefix = "paid-retention-"

// Deliberately exposes only bucket policy operations.
type policyClient interface {
	GetBucketLifecycle(context.Context, string) (*lifecycle.Configuration, error)
	SetBucketLifecycle(context.Context, string, *lifecycle.Configuration) error
}

func reconcile(ctx context.Context, client policyClient, bucket string, days []int) (bool, error) {
	desired := map[string]lifecycle.Rule{}
	for _, day := range days {
		if day <= 0 {
			return false, fmt.Errorf("retention days must be positive: %d", day)
		}
		id := fmt.Sprintf("%s%d", rulePrefix, day)
		desired[id] = lifecycle.Rule{ID: id, Status: "Enabled", RuleFilter: lifecycle.Filter{Tag: lifecycle.Tag{Key: "retention", Value: strconv.Itoa(day)}}, Expiration: lifecycle.Expiration{Days: lifecycle.ExpirationDays(day)}}
	}
	if len(desired) == 0 {
		return false, fmt.Errorf("at least one retention duration is required")
	}
	if len(desired) > 1000 {
		return false, fmt.Errorf("S3 supports at most 1000 lifecycle rules")
	}
	current, err := client.GetBucketLifecycle(ctx, bucket)
	if err != nil {
		if minio.ToErrorResponse(err).Code != "NoSuchLifecycleConfiguration" {
			return false, fmt.Errorf("get lifecycle: %w", err)
		}
		current = &lifecycle.Configuration{}
	}
	rules := make([]lifecycle.Rule, 0, len(current.Rules)+len(desired))
	changed := false
	for _, rule := range current.Rules {
		if !strings.HasPrefix(rule.ID, rulePrefix) {
			rules = append(rules, rule)
			continue
		}
		want, ok := desired[rule.ID]
		if !ok {
			changed = true
			continue
		}
		actualJSON, err := json.Marshal(rule)
		if err != nil {
			return false, err
		}
		desiredJSON, err := json.Marshal(want)
		if err != nil {
			return false, err
		}
		if !bytes.Equal(actualJSON, desiredJSON) {
			changed = true
		}
		rules = append(rules, want)
		delete(desired, rule.ID)
	}
	ids := make([]string, 0, len(desired))
	for id := range desired {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		rules = append(rules, desired[id])
		changed = true
	}
	if len(rules) > 1000 {
		return false, fmt.Errorf("managed and unrelated policies exceed the 1000-rule S3 limit")
	}
	if !changed {
		return false, nil
	}
	if err := client.SetBucketLifecycle(ctx, bucket, &lifecycle.Configuration{Rules: rules}); err != nil {
		return false, fmt.Errorf("set lifecycle: %w", err)
	}
	return true, nil
}

func main() {
	for _, key := range []string{"MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "MINIO_BUCKET", "S3_RETENTION_DAYS"} {
		if os.Getenv(key) == "" {
			log.Fatalf("%s is required", key)
		}
	}
	secure := true
	if value := os.Getenv("S3_SECURE"); value != "" {
		var err error
		secure, err = strconv.ParseBool(value)
		if err != nil {
			log.Fatalf("parse S3_SECURE: %v", err)
		}
	}
	var days []int
	if err := json.Unmarshal([]byte(os.Getenv("S3_RETENTION_DAYS")), &days); err != nil {
		log.Fatalf("parse S3_RETENTION_DAYS: %v", err)
	}
	client, err := minio.New(os.Getenv("MINIO_ENDPOINT"), &minio.Options{Secure: secure, Creds: credentials.NewStaticV4(os.Getenv("MINIO_ACCESS_KEY"), os.Getenv("MINIO_SECRET_KEY"), ""), Region: os.Getenv("AWS_DEFAULT_REGION")})
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	changed, err := reconcile(ctx, client, os.Getenv("MINIO_BUCKET"), days)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("S3 retention rules reconciled; changed=%t", changed)
}
