package main

import (
	"context"
	"database/sql"
	"github.com/atticplaygroup/paid-services/infrastructure/internal/index"
	schema "github.com/atticplaygroup/paid-services/infrastructure/internal/index/db"
	indexdb "github.com/atticplaygroup/paid-services/infrastructure/internal/index/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1/indexconnect"
	_ "github.com/go-sql-driver/mysql"
	"log"
	"net/http"
	"os"
	"time"
)

func main() {
	scorers, err := index.ParseEnabledScorers([]byte(os.Getenv("ENABLED_SCORERS")))
	if err != nil {
		log.Fatal(err)
	}
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		log.Fatal("MYSQL_DSN is required")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(20)
	db.SetConnMaxLifetime(3 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for {
		if err = db.PingContext(ctx); err == nil {
			break
		}
		if ctx.Err() != nil {
			log.Fatal(err)
		}
		time.Sleep(time.Second)
	}
	if _, err = db.ExecContext(ctx, schema.Schema); err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("LISTEN_ADDRESS")
	if addr == "" {
		addr = ":3000"
	}
	path, handler := index.NewHandler(&index.Server{Queries: indexdb.New(db), Scorers: scorers})
	connecthttp.Serve(connecthttp.Options{
		Address:  addr,
		Handlers: append([]connecthttp.Handler{{Path: path, Handler: handler}}, connecthttp.ReflectHandlers(indexconnect.IndexServiceName)...),
		ExtraHandlers: []connecthttp.Route{{Pattern: "GET /healthz", Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if db.PingContext(r.Context()) != nil {
				http.Error(w, "database unavailable", 503)
				return
			}
			w.WriteHeader(200)
		})}},
	})
}
