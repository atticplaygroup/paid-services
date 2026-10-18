#!/bin/bash
set -euo pipefail
required=(MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_EXPORT_SCHEMAS MYSQL_BINLOG_DIR OUTPUT_DIR)
for var in "${required[@]}"; do
  [[ -n "${!var:-}" ]] || { echo "missing env: $var" >&2; exit 1; }
done
mkdir -p "$OUTPUT_DIR"
export MYSQL_PWD="$MYSQL_PASSWORD"
mysql_args=(-h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER")
STATUS=$(mysql "${mysql_args[@]}" -Nse 'SHOW MASTER STATUS')
DO_DB=$(cut -f 3 <<< "$STATUS")
IGNORE_DB=$(cut -f 4 <<< "$STATUS")
SETTINGS=$(mysql "${mysql_args[@]}" -Nse 'SELECT @@GLOBAL.binlog_format, @@GLOBAL.binlog_rows_query_log_events')
if [[ $(tr ',' '\n' <<< "$DO_DB" | sort) != $(tr ',' '\n' <<< "$MYSQL_EXPORT_SCHEMAS" | sort) ||
      -n "$IGNORE_DB" || "$SETTINGS" != $'ROW\t0' ]]; then
  echo 'source must use ROW binlogs, disable binlog_rows_query_log_events, and set binlog-do-db exactly to MYSQL_EXPORT_SCHEMAS with no binlog-ignore-db' >&2
  exit 1
fi
# Rotate first so every exported file is closed and can be replayed completely.
BOUNDARY=$(mysql "${mysql_args[@]}" -Nse 'FLUSH BINARY LOGS; SHOW MASTER STATUS')
BINLOG_FILE=$(cut -f 1 <<< "$BOUNDARY")
while read -r file _; do
  [[ "$file" == "$BINLOG_FILE" ]] && break
  [[ "$file" =~ ^[A-Za-z0-9_-]+\.[0-9]+$ ]] || { echo 'invalid binlog filename' >&2; exit 1; }
  # Hard links pin the closed files without copying their contents. OUTPUT_DIR
  # must be on the MySQL volume. MySQL still controls source-name expiration.
  ln "$MYSQL_BINLOG_DIR/$file" "$OUTPUT_DIR/$file"
done < <(mysql "${mysql_args[@]}" -Nse 'SHOW BINARY LOGS')
# Derive coverage only from these closed files. Previous-GTIDs contains
# all source history before the first file, including transactions filtered out
# of earlier binlogs; transaction events extend that set through these files.
mapfile -t files < <(find "$OUTPUT_DIR" -maxdepth 1 -type f -regextype posix-extended -regex '.*\.[0-9]+' | sort)
(( ${#files[@]} > 0 )) || { echo 'no closed binlogs available' >&2; exit 1; }
metadata=$(mktemp)
trap 'rm -f "$metadata"' EXIT
mysqlbinlog --base64-output=DECODE-ROWS "${files[@]}" > "$metadata"
BINLOG_METADATA_FILE="$metadata" mysql-binlog-coverage.js
