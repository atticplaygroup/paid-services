package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
)

type accessPolicy struct {
	Schemas []string            `json:"schemas"`
	Tables  map[string][]string `json:"tables"`
}

var accountName = regexp.MustCompile(`^[a-zA-Z0-9_]{1,32}$`)

func identifier(value string) (string, error) {
	if value == "" || strings.ContainsAny(value, "\x00%\\") {
		return "", fmt.Errorf("invalid access identifier %q", value)
	}
	return "`" + strings.ReplaceAll(value, "`", "``") + "`", nil
}
func provision(ctx context.Context, adminDSN, user, password string, policy accessPolicy) (string, error) {
	if !accountName.MatchString(user) || password == "" {
		return "", fmt.Errorf("reader requires a valid account name and nonempty password")
	}
	if len(policy.Schemas) == 0 && len(policy.Tables) == 0 {
		return "", fmt.Errorf("access policy must explicitly allow schemas or tables")
	}
	// Validate the entire policy before changing an existing account.
	for _, schema := range policy.Schemas {
		if _, err := identifier(schema); err != nil {
			return "", err
		}
	}
	for schema, tables := range policy.Tables {
		if _, err := identifier(schema); err != nil {
			return "", err
		}
		if len(tables) == 0 {
			return "", fmt.Errorf("table whitelist for %q is empty", schema)
		}
		for _, table := range tables {
			if _, err := identifier(table); err != nil {
				return "", err
			}
		}
	}
	cfg, err := mysql.ParseDSN(adminDSN)
	if err != nil {
		return "", err
	}
	if cfg.User == user {
		return "", fmt.Errorf("reader and provisioning accounts must differ")
	}
	// MySQL account DDL does not accept server-side prepared parameters.
	// Let the driver escape and interpolate the password using server SQL mode.
	cfg.InterpolateParams = true
	db, err := openDatabase(cfg.FormatDSN())
	if err != nil {
		return "", err
	}
	defer db.Close()
	conn, err := db.Conn(ctx)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	// Account setup must not add local GTIDs to a replica's published history.
	if _, err = conn.ExecContext(ctx, "SET SESSION sql_log_bin=0"); err != nil {
		return "", err
	}
	account := "'" + user + "'@'%'"
	if _, err = conn.ExecContext(ctx, "CREATE USER IF NOT EXISTS "+account+" IDENTIFIED BY ?", password); err != nil {
		return "", err
	}
	if _, err = conn.ExecContext(ctx, "ALTER USER "+account+" IDENTIFIED BY ?", password); err != nil {
		return "", err
	}
	if _, err = conn.ExecContext(ctx, "REVOKE ALL PRIVILEGES, GRANT OPTION FROM "+account); err != nil {
		return "", err
	}
	for _, schema := range policy.Schemas {
		name, e := identifier(schema)
		if e != nil {
			return "", e
		}
		// Database-level GRANT treats _ as a wildcard even in quoted identifiers.
		name = strings.ReplaceAll(name, "_", `\_`)
		if _, err = conn.ExecContext(ctx, "GRANT SELECT ON "+name+".* TO "+account); err != nil {
			return "", err
		}
	}
	for schema, tables := range policy.Tables {
		dbName, e := identifier(schema)
		if e != nil {
			return "", e
		}
		for _, table := range tables {
			tableName, e := identifier(table)
			if e != nil {
				return "", e
			}
			if _, err = conn.ExecContext(ctx, "GRANT SELECT ON "+dbName+"."+tableName+" TO "+account); err != nil {
				return "", err
			}
		}
	}
	cfg.User, cfg.Passwd = user, password
	cfg.InterpolateParams = false
	cfg.ParseTime, cfg.MultiStatements, cfg.AllowAllFiles, cfg.AllowCleartextPasswords = false, false, false, false
	return cfg.FormatDSN(), nil
}
func provisionFromEnvironment() error {
	var policy accessPolicy
	if err := json.Unmarshal([]byte(os.Getenv("MYSQL_ACCESS")), &policy); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var last error
	for ctx.Err() == nil {
		dsn, err := provision(ctx, os.Getenv("MYSQL_ADMIN_DSN"), os.Getenv("MYSQL_READER_USER"), os.Getenv("MYSQL_READER_PASSWORD"), policy)
		if err == nil {
			return os.WriteFile(env("MYSQL_DSN_FILE", "/runtime/reader-dsn"), []byte(dsn), 0600)
		}
		last = err
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("provision reader: %w", last)
}
