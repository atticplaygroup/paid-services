package migrations

import (
	"bytes"
	"embed"
	"io/fs"
	"strings"

	migrate "github.com/rubenv/sql-migrate"
)

//go:embed *.sql
var files embed.FS

type Source struct{}

func (Source) FindMigrations() ([]*migrate.Migration, error) {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return nil, err
	}
	migrations := make([]*migrate.Migration, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		content, err := files.ReadFile(entry.Name())
		if err != nil {
			return nil, err
		}
		migration, err := migrate.ParseMigration(entry.Name(), bytes.NewReader(content))
		if err != nil {
			return nil, err
		}
		migrations = append(migrations, migration)
	}
	return migrations, nil
}
