package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type gateway struct {
	dsn            string
	timeout        time.Duration
	maxResultBytes int
}

type queryRequest struct {
	SQL        string `json:"sql"`
	Parameters []any  `json:"parameters"`
}
type queryResult struct {
	Columns []string    `json:"columns"`
	Rows    [][]*string `json:"rows"`
}

func openDatabase(dsn string) (*sql.DB, error) {
	cfg, err := mysql.ParseDSN(dsn)
	if err != nil {
		return nil, err
	}
	// Keep database values as their textual representation, including exact decimals.
	cfg.ParseTime = false
	cfg.MultiStatements = false
	cfg.Timeout = 5 * time.Second
	connector, err := mysql.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(0)
	return db, nil
}

func (g *gateway) kill(id uint64) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := openDatabase(g.dsn)
	if err != nil {
		log.Printf("open cancellation connection: %v", err)
		return
	}
	defer db.Close()
	// MySQL permits a user to terminate its own connections without CONNECTION_ADMIN.
	if _, err = db.ExecContext(ctx, fmt.Sprintf("KILL CONNECTION %d", id)); err != nil {
		var sqlErr *mysql.MySQLError
		if !errors.As(err, &sqlErr) || sqlErr.Number != 1094 {
			log.Printf("cancel query: %v", err)
		}
	}
}

func (g *gateway) execute(parent context.Context, statement string, parameters ...any) (queryResult, error) {
	result := queryResult{Columns: []string{}, Rows: [][]*string{}}
	ctx, cancel := context.WithTimeout(parent, g.timeout)
	defer cancel()
	db, err := openDatabase(g.dsn)
	if err != nil {
		return result, err
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		return result, err
	}
	defer conn.Close()
	var id uint64
	if err = conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&id); err != nil {
		return result, err
	}
	killed := make(chan struct{})
	stop := context.AfterFunc(ctx, func() { defer close(killed); g.kill(id) })
	defer func() {
		if !stop() {
			<-killed
		}
	}()
	rows, err := conn.QueryContext(ctx, statement, parameters...)
	if err != nil {
		return result, err
	}
	fullyRead := false
	defer func() {
		if !fullyRead {
			cancel() // Stop server work before closing an unread result stream.
		}
		rows.Close()
	}()
	result.Columns, err = rows.Columns()
	if err != nil {
		return result, err
	}
	size := 0
	for rows.Next() {
		raw := make([]sql.RawBytes, len(result.Columns))
		dest := make([]any, len(raw))
		for i := range raw {
			dest[i] = &raw[i]
		}
		if err = rows.Scan(dest...); err != nil {
			return result, err
		}
		values := make([]*string, len(raw))
		for i, value := range raw {
			if value != nil {
				text := string(value)
				values[i] = &text
				size += len(text)
			}
			size += 8
		}
		if size > g.maxResultBytes {
			return result, errResultTooLarge
		}
		result.Rows = append(result.Rows, values)
	}
	fullyRead = rows.Err() == nil
	return result, rows.Err()
}

var errResultTooLarge = errors.New("query result exceeds configured size limit")

// Only JSON scalar values map to MySQL bind values. Never interpolate SQL text.
func bindParameters(values []any) ([]any, error) {
	parameters := make([]any, len(values))
	for i, value := range values {
		switch value := value.(type) {
		case nil, string, bool:
			parameters[i] = value
		case json.Number:
			if n, err := value.Int64(); err == nil {
				parameters[i] = n
			} else if n, err := strconv.ParseUint(string(value), 10, 64); err == nil {
				parameters[i] = n
			} else if !strings.ContainsAny(string(value), ".eE") {
				return nil, fmt.Errorf("parameter %d is outside the integer range; send exact values as strings", i)
			} else if n, err := value.Float64(); err == nil {
				parameters[i] = n
			} else {
				return nil, fmt.Errorf("parameter %d is outside the numeric range; send exact values as strings", i)
			}
		default:
			return nil, fmt.Errorf("parameter %d must be a string, number, boolean, or null", i)
		}
	}
	return parameters, nil
}

func (g *gateway) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("POST /sql", func(w http.ResponseWriter, r *http.Request) {
		var request queryRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.UseNumber()
		if err := decoder.Decode(&request); err != nil || request.SQL == "" {
			http.Error(w, "expected JSON with a nonempty sql string", 400)
			return
		}
		parameters, err := bindParameters(request.Parameters)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		result, err := g.execute(r.Context(), request.SQL, parameters...)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, context.DeadlineExceeded) {
				status = http.StatusGatewayTimeout
			}
			if errors.Is(err, context.Canceled) {
				status = http.StatusRequestTimeout
			}
			if errors.Is(err, errResultTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(w, err.Error(), status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
	return mux
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--provision" {
		if err := provisionFromEnvironment(); err != nil {
			log.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(env("MYSQL_DSN_FILE", "/runtime/reader-dsn"))
	if err != nil {
		log.Fatal(err)
	}
	timeout, err := time.ParseDuration(env("QUERY_TIMEOUT", "30s"))
	if err != nil || timeout <= 0 {
		log.Fatal("QUERY_TIMEOUT must be a positive duration")
	}
	size, err := strconv.Atoi(env("MAX_RESULT_BYTES", "8388608"))
	if err != nil || size <= 0 {
		log.Fatal("MAX_RESULT_BYTES must be positive")
	}
	g := &gateway{dsn: string(data), timeout: timeout, maxResultBytes: size}
	server := &http.Server{Addr: env("LISTEN_ADDRESS", ":3000"), Handler: g.handler(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(server.ListenAndServe())
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
