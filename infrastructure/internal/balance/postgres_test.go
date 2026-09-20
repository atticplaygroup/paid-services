package balance_test

import (
	"context"
	"database/sql"
	"testing"
	"time"

	balance "github.com/atticplaygroup/paid-services/infrastructure/internal/balance"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/migrations"
	db "github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/sqlc"
	testpostgres "github.com/atticplaygroup/paid-services/infrastructure/testing"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/lib/pq"
	migrate "github.com/rubenv/sql-migrate"
)

func setupPostgresStore(t *testing.T) *balance.PostgresStore {
	t.Helper()
	databaseURL := testpostgres.StartPostgres(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(pool.Close)
	testDb, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(func() { _ = testDb.Close() })
	if _, err := migrate.Exec(testDb, "postgres", migrations.Source{}, migrate.Down); err != nil {
		t.Logf("migrate down: %v", err)
	}
	if _, err := testDb.Exec(`DROP TABLE IF EXISTS
		used_exchange_tokens,
		withdrawals,
		processing_withdrawals,
		deposits,
		accounts CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := migrate.Exec(testDb, "postgres", migrations.Source{}, migrate.Up); err != nil {
		t.Fatalf("migrate up: %v", err)
	}
	if _, err := db.New(pool).DeleteAccountByPrincipal(context.Background(), "balance-store-test-principal"); err != nil {
		t.Fatalf("clean fixture: %v", err)
	}

	store, err := balance.NewPostgresStore(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func TestPostgresStoreWithExchangeAccounts(t *testing.T) {
	ctx := context.Background()
	store := setupPostgresStore(t)

	principal := "balance-store-test-principal"
	created, err := store.Increment(ctx, principal, 100)
	if err != nil {
		t.Fatalf("Increment: %v", err)
	}
	if created != 100 {
		t.Fatalf("created balance=%d want 100", created)
	}
	deducted, err := store.Deduct(ctx, principal, 25)
	if err != nil {
		t.Fatalf("Deduct: %v", err)
	}
	if deducted != 75 {
		t.Fatalf("deducted balance=%d want 75", deducted)
	}
	current, err := store.Get(ctx, principal)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if current != 75 {
		t.Fatalf("balance=%d want 75", current)
	}
	if _, err := store.Deduct(ctx, principal, 76); err != balance.ErrNotFound {
		t.Fatalf("error=%v want ErrNotFound", err)
	}
	if _, err := store.Get(ctx, "balance-store-test-missing"); err != balance.ErrNotFound {
		t.Fatalf("error=%v want ErrNotFound", err)
	}
	if balance.DefaultTTL <= time.Second {
		t.Fatal("default account TTL should mirror the exchange account lifetime")
	}
}
