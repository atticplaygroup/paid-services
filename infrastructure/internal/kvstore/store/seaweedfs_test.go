package store

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
	"github.com/ory/dockertest/v3"
	"github.com/ory/dockertest/v3/docker"
)

// Exercise the real S3 backend, including tagging that the in-memory fake omits.
func TestSeaweedFSS3(t *testing.T) {
	pool, err := dockertest.NewPool("")
	if err != nil {
		t.Fatal(err)
	}
	pool.MaxWait = 90 * time.Second
	const repository = "chrislusf/seaweedfs"
	const digest = "sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d"
	const tag = "4.48@" + digest
	// RunWithOptions treats Tag as a pull tag, which cannot contain @digest.
	// Pull by digest first so its image lookup succeeds on a fresh runner.
	if _, err := pool.Client.InspectImage(repository + ":" + tag); err != nil {
		if err := pool.Client.PullImage(docker.PullImageOptions{
			Repository: repository,
			Tag:        digest,
		}, docker.AuthConfiguration{}); err != nil {
			t.Fatalf("pull pinned SeaweedFS image: %v", err)
		}
	}
	config := filepath.Join(t.TempDir(), "s3.json")
	if err := os.WriteFile(config, []byte(`{"identities":[{"name":"test","credentials":[{"accessKey":"test","secretKey":"testtest"}],"actions":["Admin","Read","Write","List","Tagging"]}]}`), 0644); err != nil {
		t.Fatal(err)
	}
	resource, err := pool.RunWithOptions(&dockertest.RunOptions{
		Repository:   repository,
		Tag:          tag,
		Cmd:          []string{"mini", "-dir=/data", "-s3.port=9000", "-s3.config=/etc/seaweedfs/s3.json", "-webdav=false", "-master.telemetry=false"},
		Mounts:       []string{config + ":/etc/seaweedfs/s3.json:ro"},
		ExposedPorts: []string{"9000/tcp", "23646/tcp"},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pool.Purge(resource); err != nil {
			t.Logf("purge SeaweedFS: %v", err)
		}
	})
	store := NewS3Store(NewS3Config("localhost:"+resource.GetPort("9000/tcp"), "test", "testtest", "kv-test", true))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := pool.Retry(func() error { return store.EnsureBucket(ctx) }); err != nil {
		t.Fatalf("SeaweedFS did not become ready: %v", err)
	}
	testIKvStore(t, store)
	ctx = middleware.WithMeter(ctx, middleware.NewMeter("s3-contract"))
	t.Run("retentionTags", func(t *testing.T) {
		const key = "tagged-object"
		if err := store.Put(ctx, key, []byte("tagged"), RetentionUnit); err != nil {
			t.Fatal(err)
		}
		if err := store.ExtendTtl(ctx, key, RetentionUnit); err != nil {
			t.Fatal(err)
		}
		tags, err := store.Client.GetObjectTagging(ctx, store.Bucket, key, minio.GetObjectTaggingOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if got := tags.ToMap()[tagRetention]; got != "20" {
			t.Fatalf("retention=%q, want 20", got)
		}
		ttl, err := store.GetTtl(ctx, key)
		if err != nil || ttl == nil || *ttl < 19*24*time.Hour || *ttl > 20*24*time.Hour {
			t.Fatalf("TTL=%v, error=%v", ttl, err)
		}
	})
	t.Run("tagFilteredExpiration", func(t *testing.T) {
		config := &lifecycle.Configuration{Rules: []lifecycle.Rule{
			{ID: "expire-ten", Status: "Enabled", RuleFilter: lifecycle.Filter{Tag: lifecycle.Tag{Key: tagRetention, Value: "10"}}, Expiration: lifecycle.Expiration{Date: lifecycle.ExpirationDate{Time: time.Now().Add(-24 * time.Hour).UTC().Truncate(24 * time.Hour)}}},
			{ID: "keep-twenty", Status: "Enabled", RuleFilter: lifecycle.Filter{Tag: lifecycle.Tag{Key: tagRetention, Value: "20"}}, Expiration: lifecycle.Expiration{Date: lifecycle.ExpirationDate{Time: time.Now().Add(20 * 24 * time.Hour).UTC().Truncate(24 * time.Hour)}}},
		}}
		if err := store.Client.SetBucketLifecycle(ctx, store.Bucket, config); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"expire-me", "extended"} {
			if err := store.Put(ctx, key, []byte(key), RetentionUnit); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.Put(ctx, "untagged", []byte("keep"), 0); err != nil {
			t.Fatal(err)
		}
		if err := store.ExtendTtl(ctx, "extended", RetentionUnit); err != nil {
			t.Fatal(err)
		}
		// Trigger the provider's native scheduler; no application deletion scan.
		adminURL := "http://localhost:" + resource.GetPort("23646/tcp")
		httpClient := &http.Client{Timeout: 40 * time.Second}
		if err := pool.Retry(func() error {
			req, _ := http.NewRequestWithContext(ctx, "GET", adminURL+"/api/plugin/scheduler-states", nil)
			resp, err := httpClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()
			data, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}
			if resp.StatusCode != 200 || !bytes.Contains(data, []byte("s3_lifecycle")) {
				return fmt.Errorf("native lifecycle scheduler not ready")
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", adminURL+"/api/plugin/job-types/s3_lifecycle/run", strings.NewReader(`{"timeout_seconds":30}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 || result["error_count"] != float64(0) {
			t.Fatalf("native lifecycle dispatch: %v", result)
		}
		if err := pool.Retry(func() error {
			_, err := store.Client.StatObject(ctx, store.Bucket, "expire-me", minio.StatObjectOptions{})
			if minio.ToErrorResponse(err).StatusCode == 404 {
				return nil
			}
			return fmt.Errorf("tagged object still exists: %v", err)
		}); err != nil {
			t.Fatalf("expiration: %v; native dispatch=%v", err, result)
		}
		for _, key := range []string{"extended", "untagged"} {
			if _, err := store.Client.StatObject(ctx, store.Bucket, key, minio.StatObjectOptions{}); err != nil {
				t.Fatalf("%s should survive: %v", key, err)
			}
		}
	})
	t.Run("unknownLengthStream", func(t *testing.T) {
		payload := strings.Repeat("streamed-bytes", 1024)
		reader := io.LimitReader(strings.NewReader(payload), int64(len(payload)))
		if err := store.PutStream(ctx, "unknown-length", reader, 0); err != nil {
			t.Fatal(err)
		}
		got, err := store.Get(ctx, "unknown-length")
		if err != nil || !bytes.Equal(got, []byte(payload)) {
			t.Fatalf("stream content differs: size=%d, error=%v", len(got), err)
		}
	})
}
