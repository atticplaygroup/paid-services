package store

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	meterpkg "github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/tags"
)

type S3Config struct {
	address   string
	accessKey string
	secretKey string
	bucket    string
	insecure  bool
}

// NewS3Config builds an S3 config. insecure=true uses HTTP.
func NewS3Config(address, accessKey, secretKey, bucket string, insecure bool) *S3Config {
	return &S3Config{
		address:   address,
		accessKey: accessKey,
		secretKey: secretKey,
		bucket:    bucket,
		insecure:  insecure,
	}
}

type S3Store struct {
	Client *minio.Client
	Bucket string
}

const tagRetention = "retention"
const RetentionUnit = 10 * 24 * time.Hour
const RetentionUnitDays = 10

func NewS3Store(c *S3Config) *S3Store {
	client, err := minio.New(c.address, &minio.Options{
		Creds: credentials.NewStaticV4(
			c.accessKey,
			c.secretKey,
			"",
		),
		Secure: !c.insecure,
	})
	if err != nil {
		log.Fatalf("initialize minio: %v", err)
	}
	return &S3Store{
		Client: client,
		Bucket: c.bucket,
	}
}

// EnsureBucket creates the bucket if missing.
func (s *S3Store) EnsureBucket(ctx context.Context) error {
	exists, err := s.Client.BucketExists(ctx, s.Bucket)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return s.Client.MakeBucket(ctx, s.Bucket, minio.MakeBucketOptions{})
}

func (s *S3Store) Exists(ctx context.Context, keys ...string) (int64, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return -1, fmt.Errorf("get usage: %w", err)
	}

	ret := int64(0)
	for _, key := range keys {
		usage.IncrGetCount()
		if _, err := s.Client.StatObject(ctx, s.Bucket, key, minio.StatObjectOptions{}); err == nil {
			ret += 1
		} else {
			response := minio.ToErrorResponse(err)
			if response.StatusCode != http.StatusNotFound {
				return -1, fmt.Errorf("%s StatObject: %v", key, err)
			}
		}
	}
	return ret, nil
}

func (s *S3Store) Stat(ctx context.Context, keys ...string) ([]StatResult, error) {
	statMeter, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}

	ret := make([]StatResult, 0, len(keys))
	for _, key := range keys {
		statMeter.IncrGetCount()
		if stat, err := s.Client.StatObject(ctx, s.Bucket, key, minio.StatObjectOptions{}); err == nil {
			ttl, err := s.objectTTL(ctx, statMeter, key, stat)
			if err != nil {
				return nil, err
			}
			ret = append(ret, StatResult{
				Key:    key,
				Name:   utils.FormatName(key),
				Exists: true,
				Size:   stat.Size,
				Ttl:    ttl,
			})
		} else {
			response := minio.ToErrorResponse(err)
			if response.StatusCode != http.StatusNotFound {
				return nil, fmt.Errorf("%s StatObject: %v", key, err)
			}
			ret = append(ret, StatResult{
				Key:    key,
				Name:   utils.FormatName(key),
				Exists: false,
				Size:   -1,
				Ttl:    -1,
			})
		}
	}
	return ret, nil
}

// objectTTL resolves remaining lifetime.
// Prefer x-amz-expiration (stat.Expiration). If absent, derive from the
// retention tag + LastModified so "no header" is not confused with "no TTL".
// Returns -1 only when neither source configures expiry.
func (s *S3Store) objectTTL(ctx context.Context, usage *meterpkg.Meter, key string, stat minio.ObjectInfo) (time.Duration, error) {
	if !stat.Expiration.IsZero() {
		return time.Until(stat.Expiration), nil
	}

	tagMap := stat.UserTags
	if len(tagMap) == 0 {
		usage.IncrGetCount()
		tagSet, err := s.Client.GetObjectTagging(ctx, s.Bucket, key, minio.GetObjectTaggingOptions{})
		if err != nil {
			// Backend may omit tagging (e.g. some fakes); treat as no retention.
			return -1, nil
		}
		tagMap = tagSet.ToMap()
	}
	val, ok := tagMap[tagRetention]
	if !ok {
		return -1, nil
	}
	days, err := strconv.Atoi(val)
	if err != nil {
		return 0, fmt.Errorf("%s parse retention days: %v", key, err)
	}
	if days <= 0 {
		return -1, nil
	}
	if stat.LastModified.IsZero() {
		return time.Duration(days) * 24 * time.Hour, nil
	}
	return time.Until(stat.LastModified.Add(time.Duration(days) * 24 * time.Hour)), nil
}

func (s *S3Store) GetTtl(ctx context.Context, key string) (*time.Duration, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}

	usage.IncrGetCount()
	results, err := s.Stat(ctx, key)
	if err != nil || len(results) != 1 {
		return nil, fmt.Errorf("GetTtl: %w", err)
	}
	return &results[0].Ttl, nil
}

func (s *S3Store) ExtendTtl(ctx context.Context, key string, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	usage.IncrGetCount()
	tagSet, err := s.Client.GetObjectTagging(ctx, s.Bucket, key, minio.GetObjectTaggingOptions{})
	if err != nil {
		return fmt.Errorf("get tag: %w", err)
	}
	var newDays int
	tagMap := tagSet.ToMap()
	val, ok := tagMap[tagRetention]
	if !ok {
		return fmt.Errorf("retention tag %s not found for %s", tagRetention, key)
	}
	days, err := strconv.Atoi(val)
	if err != nil {
		return fmt.Errorf("parse retention days: %w", err)
	}
	newDays = days + int(ttl.Hours()/24/RetentionUnitDays)*RetentionUnitDays
	tagMap[tagRetention] = strconv.Itoa(newDays)
	newTags, err := tags.NewTags(tagMap, true)
	if err != nil {
		return fmt.Errorf("validate tags: %w", err)
	}
	usage.IncrSetCount()
	if err := s.Client.PutObjectTagging(ctx, s.Bucket, key, newTags, minio.PutObjectTaggingOptions{}); err != nil {
		return fmt.Errorf("put tag: %w", err)
	}
	return nil
}

func (s *S3Store) Get(ctx context.Context, key string) ([]byte, error) {
	rc, err := s.GetStream(ctx, key)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rc.Close() }()
	return io.ReadAll(rc)
}

func (s *S3Store) GetStream(ctx context.Context, key string) (io.ReadCloser, error) {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("get usage: %w", err)
	}

	usage.IncrGetCount()
	obj, err := s.Client.GetObject(ctx, s.Bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("%s GetObject: %v", key, err)
	}
	// Stat forces the GET error (e.g. NoSuchKey) to surface before the caller reads.
	if _, err := obj.Stat(); err != nil {
		_ = obj.Close()
		response := minio.ToErrorResponse(err)
		if response.StatusCode == http.StatusNotFound {
			return nil, fmt.Errorf("%s: not found", key)
		}
		return nil, fmt.Errorf("%s GetObject: %v", key, err)
	}
	return obj, nil
}

func (s *S3Store) Put(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return s.putObject(ctx, key, bytes.NewReader(value), int64(len(value)), ttl)
}

func (s *S3Store) PutStream(ctx context.Context, key string, r io.Reader, ttl time.Duration) error {
	size := int64(-1)
	if lr, ok := r.(interface{ Len() int }); ok {
		size = int64(lr.Len())
	}
	return s.putObject(ctx, key, r, size, ttl)
}

func (s *S3Store) putObject(ctx context.Context, key string, r io.Reader, size int64, ttl time.Duration) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	days := retentionDays(ttl)
	tagMap := map[string]string{}
	if days > 0 {
		tagMap[tagRetention] = strconv.Itoa(days)
	}
	opts := minio.PutObjectOptions{}
	if len(tagMap) > 0 {
		t, err := tags.NewTags(tagMap, true)
		if err != nil {
			return fmt.Errorf("validate tags: %w", err)
		}
		opts.UserTags = t.ToMap()
	}

	usage.IncrSetCount()
	// Pass a known size when possible. size=-1 makes minio-go use aws-chunked
	// streaming signatures; gofakes3 (and some S3 mocks) store that framing
	// as the object body.
	_, err = s.Client.PutObject(ctx, s.Bucket, key, r, size, opts)
	if err != nil {
		return fmt.Errorf("%s PutObject: %v", key, err)
	}
	return nil
}

func (s *S3Store) Rename(ctx context.Context, oldKey string, newKey string) error {
	usage, err := meterpkg.MeterFromContext(ctx)
	if err != nil {
		return fmt.Errorf("get usage: %w", err)
	}

	if oldKey == newKey {
		return nil
	}

	usage.IncrGetCount()
	src := minio.CopySrcOptions{Bucket: s.Bucket, Object: oldKey}
	dst := minio.CopyDestOptions{Bucket: s.Bucket, Object: newKey}
	usage.IncrSetCount()
	if _, err := s.Client.CopyObject(ctx, dst, src); err != nil {
		return fmt.Errorf("CopyObject %s -> %s: %v", oldKey, newKey, err)
	}
	usage.IncrSetCount()
	if err := s.Client.RemoveObject(ctx, s.Bucket, oldKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("RemoveObject %s: %v", oldKey, err)
	}
	return nil
}

func (s *S3Store) Close() error {
	return nil
}

// retentionDays quantizes ttl into retentionUnitDays chunks (0 if ttl <= 0).
func retentionDays(ttl time.Duration) int {
	if ttl <= 0 {
		return 0
	}
	units := int(ttl / RetentionUnit)
	if units < 1 {
		units = 1
	}
	return units * RetentionUnitDays
}
