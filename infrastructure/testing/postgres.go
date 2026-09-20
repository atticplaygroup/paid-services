// Package testing provides database fixtures for Go tests. It must not be
// imported by production code.
package testing

import (
	"database/sql"
	"fmt"
	"testing"

	_ "github.com/lib/pq"
	"github.com/ory/dockertest/v3"
)

var pool *dockertest.Pool

func StartPostgres(t *testing.T) string {
	t.Helper()
	if pool == nil {
		testPool, err := dockertest.NewPool("")
		if err != nil {
			t.Fatalf("connect docker: %v", err)
		}
		pool = testPool
	}
	resource, err := pool.Run("postgres", "16", []string{
		"POSTGRES_PASSWORD=postgres",
	})
	if err != nil {
		t.Fatalf("start postgres: %v", err)
	}
	t.Cleanup(func() {
		if err := pool.Purge(resource); err != nil {
			t.Logf("purge postgres: %v", err)
		}
	})
	databaseURL := fmt.Sprintf(
		"postgres://postgres:postgres@localhost:%s/postgres?sslmode=disable",
		resource.GetPort("5432/tcp"),
	)
	if err := pool.Retry(func() error {
		testDb, err := sql.Open("postgres", databaseURL)
		if err != nil {
			return err
		}
		defer testDb.Close()
		return testDb.Ping()
	}); err != nil {
		t.Fatalf("postgres did not become ready: %v", err)
	}
	return databaseURL
}
