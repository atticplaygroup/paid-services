package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ory/dockertest/v3"
)

// Use the deployed MySQL version so privilege and cancellation behavior is real.
func TestMySQLContract(t *testing.T) {
	pool, err := dockertest.NewPool("")
	if err != nil {
		t.Fatal(err)
	}
	resource, err := pool.Run("mysql", "8.0.42", []string{"MYSQL_ROOT_PASSWORD=test", "MYSQL_ROOT_HOST=%"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := pool.Purge(resource); err != nil {
			t.Error(err)
		}
	})
	dsn := fmt.Sprintf("root:test@tcp(127.0.0.1:%s)/", resource.GetPort("3306/tcp"))
	admin, err := openDatabase(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	pool.MaxWait = 90 * time.Second
	if err := pool.Retry(func() error { return admin.Ping() }); err != nil {
		t.Fatal(err)
	}
	exec := func(q string) {
		t.Helper()
		if _, err := admin.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	for _, q := range []string{
		"CREATE DATABASE public_catalog", "CREATE DATABASE publicXcatalog", "CREATE DATABASE private_auth",
		"CREATE TABLE public_catalog.items (id BIGINT, amount DECIMAL(30,10), missing TEXT)",
		"INSERT INTO public_catalog.items VALUES (9007199254740993, 12345678901234567890.1234567890, NULL)",
		"CREATE TABLE public_catalog.hidden (id INT)", "CREATE TABLE publicXcatalog.items (id INT)", "CREATE TABLE private_auth.secret (id INT)",
	} {
		exec(q)
	}
	reader, err := provision(context.Background(), dsn, "reader", "reader-secret", accessPolicy{Tables: map[string][]string{"public_catalog": {"items"}}})
	if err != nil {
		t.Fatal(err)
	}
	g := &gateway{dsn: reader, timeout: 2 * time.Second, maxResultBytes: 1024}
	t.Run("lossless strings and null", func(t *testing.T) {
		r, err := g.execute(context.Background(), "SELECT * FROM public_catalog.items")
		if err != nil {
			t.Fatal(err)
		}
		if len(r.Rows) != 1 || *r.Rows[0][0] != "9007199254740993" || *r.Rows[0][1] != "12345678901234567890.1234567890" || r.Rows[0][2] != nil {
			t.Fatalf("unexpected result: %+v", r)
		}
	})
	t.Run("HTTP bound parameters preserve values and isolate SQL text", func(t *testing.T) {
		server := httptest.NewServer(g.handler())
		defer server.Close()
		post := func(body string, status int) queryResult {
			t.Helper()
			response, err := http.Post(server.URL+"/sql", "application/json", strings.NewReader(body))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != status {
				t.Fatalf("HTTP %d, wanted %d", response.StatusCode, status)
			}
			var result queryResult
			if status == 200 {
				if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
					t.Fatal(err)
				}
			}
			return result
		}
		result := post(`{"sql":"SELECT ?, ?, ?, ?, ?, ?", "parameters":["x'; DROP TABLE items; --",true,null,9007199254740993,18446744073709551615,1.25]}`, 200)
		if *result.Rows[0][0] != "x'; DROP TABLE items; --" || *result.Rows[0][1] != "1" || result.Rows[0][2] != nil || *result.Rows[0][3] != "9007199254740993" || *result.Rows[0][4] != "18446744073709551615" || *result.Rows[0][5] != "1.25" {
			t.Fatalf("wrong bound values: %+v", result.Rows)
		}
		result = post(`{"sql":"SELECT id FROM public_catalog.items WHERE id = ? LIMIT ?", "parameters":["9007199254740993",1]}`, 200)
		if len(result.Rows) != 1 || *result.Rows[0][0] != "9007199254740993" {
			t.Fatal("parameterized predicate or LIMIT failed")
		}
		post(`{"sql":"SELECT ?", "parameters":[{"x":1}]}`, 400)
		post(`{"sql":"SELECT ?", "parameters":[[1,2]]}`, 400)
		post(`{"sql":"SELECT ?", "parameters":[]}`, 400)
		post(`{"sql":"SELECT ?", "parameters":[18446744073709551616]}`, 400)
		post(`{"sql":"SELECT ?", "parameters":[1e1000]}`, 400)
		post(`{"sql":"DELETE FROM public_catalog.items WHERE id = ?", "parameters":[1]}`, 400)
	})
	t.Run("privileges", func(t *testing.T) {
		for _, q := range []string{"INSERT INTO public_catalog.items (id) VALUES (2)", "DELETE FROM public_catalog.items", "DROP TABLE public_catalog.items", "SELECT * FROM public_catalog.hidden", "SELECT * FROM private_auth.secret", "SELECT * FROM publicXcatalog.items", "SELECT 1; SELECT 2"} {
			if _, err := g.execute(context.Background(), q); err == nil {
				t.Errorf("unexpected success: %s", q)
			}
		}
	})
	t.Run("fresh sessions and locks", func(t *testing.T) {
		r, err := g.execute(context.Background(), "SELECT CONNECTION_ID(), GET_LOCK('paid-contract',0), @marker := 123")
		if err != nil {
			t.Fatal(err)
		}
		if *r.Rows[0][1] != "1" {
			t.Fatal("lock was not acquired")
		}
		r2, err := g.execute(context.Background(), "SELECT CONNECTION_ID(), @marker, IS_FREE_LOCK('paid-contract')")
		if err != nil {
			t.Fatal(err)
		}
		if *r.Rows[0][0] == *r2.Rows[0][0] || r2.Rows[0][1] != nil || *r2.Rows[0][2] != "1" {
			t.Fatal("session or lock leaked")
		}
	})
	assertStopped := func(t *testing.T) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for {
			var n int
			err := admin.QueryRow("SELECT COUNT(*) FROM information_schema.processlist WHERE USER='reader'").Scan(&n)
			if err != nil {
				t.Fatal(err)
			}
			if n == 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("%d reader connections survived", n)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	t.Run("completion and oversized results close transactions and locks", func(t *testing.T) {
		if _, err := g.execute(context.Background(), "START TRANSACTION READ ONLY"); err != nil {
			t.Fatal(err)
		}
		assertStopped(t)
		if _, err := g.execute(context.Background(), "SELECT GET_LOCK('paid-too-large',0), REPEAT('x',4096)"); !errors.Is(err, errResultTooLarge) {
			t.Fatalf("got %v", err)
		}
		assertStopped(t)
		var free int
		if err := admin.QueryRow("SELECT IS_FREE_LOCK('paid-too-large')").Scan(&free); err != nil || free != 1 {
			t.Fatalf("lock survived: %d %v", free, err)
		}
	})
	t.Run("SQL errors release acquired locks", func(t *testing.T) {
		_, err := g.execute(context.Background(), "SELECT JSON_EXTRACT(CONCAT(GET_LOCK('paid-error',0), 'invalid-json'), '$') FROM public_catalog.items FOR SHARE")
		if err == nil {
			t.Fatal("expected invalid JSON error")
		}
		assertStopped(t)
		var free int
		if err := admin.QueryRow("SELECT IS_FREE_LOCK('paid-error')").Scan(&free); err != nil || free != 1 {
			t.Fatalf("error left advisory lock: %d %v", free, err)
		}
		if _, err := admin.Exec("UPDATE public_catalog.items SET id=id"); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("timeout kills server work", func(t *testing.T) {
		short := *g
		short.timeout = 150 * time.Millisecond
		_, err := short.execute(context.Background(), "SELECT GET_LOCK('paid-timeout',0), SLEEP(60) FROM public_catalog.items FOR SHARE")
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v", err)
		}
		assertStopped(t)
		var free int
		if err := admin.QueryRow("SELECT IS_FREE_LOCK('paid-timeout')").Scan(&free); err != nil || free != 1 {
			t.Fatalf("lock survived: %d %v", free, err)
		}
	})
	t.Run("disconnect kills server work", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := g.execute(ctx, "SELECT GET_LOCK('paid-disconnect',0), SLEEP(60) FROM public_catalog.items FOR SHARE")
			done <- err
		}()
		deadline := time.Now().Add(time.Second)
		for {
			var owner sql.NullInt64
			if err := admin.QueryRow("SELECT IS_USED_LOCK('paid-disconnect')").Scan(&owner); err != nil {
				t.Fatal(err)
			}
			if owner.Valid {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("query never started")
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
		assertStopped(t)
	})
	t.Run("schema grant escapes wildcard", func(t *testing.T) {
		newDSN, err := provision(context.Background(), dsn, "schema_reader", "secret", accessPolicy{Schemas: []string{"public_catalog"}})
		if err != nil {
			t.Fatal(err)
		}
		sg := *g
		sg.dsn = newDSN
		if _, err := sg.execute(context.Background(), "SELECT * FROM public_catalog.hidden"); err != nil {
			t.Fatal(err)
		}
		if _, err := sg.execute(context.Background(), "SELECT * FROM publicXcatalog.items"); err == nil {
			t.Fatal("schema wildcard leaked access")
		}
	})
}

// Cross-origin policy belongs to Envoy; direct service responses cannot override it.
func TestHandlerDoesNotAuthorizeCrossOriginRequests(t *testing.T) {
	handler := (&gateway{}).handler()
	for _, method := range []string{http.MethodOptions, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/sql", strings.NewReader("{}"))
			request.Header.Set("Origin", "https://untrusted.example")
			request.Header.Set("Access-Control-Request-Method", "POST")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if origin := response.Header().Get("Access-Control-Allow-Origin"); origin != "" {
				t.Fatalf("backend must not grant cross-origin access: %q", origin)
			}
			if response.Code < 400 {
				t.Fatalf("unexpected successful request: %d", response.Code)
			}
		})
	}
}
