package main

import (
	"database/sql"
	"log"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	migrate "github.com/rubenv/sql-migrate"

	"github.com/atticplaygroup/paid-services/infrastructure/internal/exchange/db/migrations"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer func() {
		if err := database.Close(); err != nil {
			log.Printf("close database: %v", err)
		}
	}()
	applied, err := migrate.Exec(database, "postgres", migrations.Source{}, migrate.Up)
	if err != nil {
		log.Fatalf("migrate database: %v", err)
	}
	log.Printf("applied %d migration(s)", applied)
}
