package store_test

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"log"
	"strings"
	"testing"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/migrations"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/store"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	testpostgres "github.com/atticplaygroup/paid-services/infrastructure/testing"
	"github.com/block-vision/sui-go-sdk/signer"
	"github.com/jackc/pgx/v5/pgxpool"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	migrate "github.com/rubenv/sql-migrate"
)

func TestStore(t *testing.T) {
	RegisterFailHandler(Fail)

	seed, err := utils.HexToBytes32("0x0000000000000000000000000000000000000000000000000000000000000001")
	if err != nil {
		t.Fatalf("parse signing seed: %v", err)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	keyID, err := utils.FormatPrincipal(privateKey.Public())
	if err != nil {
		t.Fatalf("format signing principal: %v", err)
	}
	walletSigner, err := signer.NewSignertWithMnemonic("test test test test test test test test test test test junk")
	if err != nil {
		t.Fatalf("load wallet mnemonic: %v", err)
	}
	conf := exchange.Config{
		TokenSigningSeed:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		TokenSigningPrivateKey: privateKey,
		TokenSigningPublic:     privateKey.Public().(ed25519.PublicKey),
		TokenSigningKeyId:      keyID.String(),
		WalletSigner:           *walletSigner,
	}
	if conf.DatabaseURL == "" {
		conf.DatabaseURL = testpostgres.StartPostgres(t)
	}

	StoreTestDb, err = sql.Open("postgres", conf.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to open db: %v\n", err)
	}
	defer func() { _ = StoreTestDb.Close() }()

	// Check if the database is reachable
	if err := StoreTestDb.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v\n", err)
	}

	Migrations = migrations.Source{}

	ctx := context.Background()

	conn, err := pgxpool.New(ctx, conf.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to db: %v\n", err)
	}
	defer conn.Close()
	StoreInstance = store.NewStore(conn)

	RunSpecs(t, "Store Suite")
}

var (
	StoreTestDb   *sql.DB
	Migrations    migrate.MigrationSource
	StoreInstance *store.Store
)

func RefreshDb(testDb *sql.DB, migrations migrate.MigrationSource) {
	_, downErr := migrate.Exec(testDb, "postgres", migrations, migrate.Down)
	if downErr != nil {
		var tableCount int
		if err := testDb.QueryRowContext(context.Background(), `
			SELECT count(*) FROM information_schema.tables
			WHERE table_schema = current_schema()
			  AND table_name IN ('used_exchange_tokens', 'withdrawals', 'processing_withdrawals', 'deposits', 'accounts')
		`).Scan(&tableCount); err != nil {
			log.Fatalf("Failed to inspect schema after migrate down: %v\n", err)
		}
		if tableCount > 0 || !strings.Contains(downErr.Error(), "migration records not found") {
			log.Fatalf("Failed to migrate down: %v\n", downErr)
		}
	}
	if _, err := migrate.Exec(testDb, "postgres", migrations, migrate.Up); err != nil {
		log.Fatalf("Failed to migrate up: %v\n", err)
	}
}
