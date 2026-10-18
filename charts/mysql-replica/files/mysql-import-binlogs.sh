#!/bin/bash
set -euo pipefail
required=(MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD DELTA_DIR)
for var in "${required[@]}"; do
  [[ -n "${!var:-}" ]] || { echo "missing env: $var" >&2; exit 1; }
done
export MYSQL_PWD="$MYSQL_PASSWORD"
mysql_args=(-h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER")
mapfile -t BINLOG_FILES < <(find "$DELTA_DIR" -maxdepth 1 -type f -regextype posix-extended -regex '.*\.[0-9]+' | sort)
(( ${#BINLOG_FILES[@]} > 0 )) || { echo 'no binlog files found' >&2; exit 1; }
for BINLOG in "${BINLOG_FILES[@]}"; do
  mysqlbinlog "$BINLOG" | mysql "${mysql_args[@]}"
done
echo 'delta import complete'
