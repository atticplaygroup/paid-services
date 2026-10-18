#!/bin/bash
# Restore and replay downloaded artifacts. OCI sync runs independently.
set -euo pipefail
: "${OUTPUT_DIR:?}"
mode=${IMPORT_MODE:-all}
[[ "$mode" == all || "$mode" == follow || "$mode" == restore || "$mode" == replay ]] || { echo 'invalid import mode' >&2; exit 1; }
if [[ "$mode" == all ]]; then sync.sh; fi
mkdir -p "$OUTPUT_DIR/deltas"
exec 9>"$OUTPUT_DIR/.mysql.lock"
flock 9
s3() {
  local args=(--region "${AWS_REGION:-us-east-1}")
  [[ -z "${S3_ENDPOINT:-}" ]] || args+=(--endpoint-url "$S3_ENDPOINT")
  aws "${args[@]}" s3 "$@"
}

check_coverage() {
  export MYSQL_PWD="$MYSQL_PASSWORD"
  mysql_args=(-h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" --raw -Nse)
  history=$(mysql "${mysql_args[@]}" 'SELECT @@GLOBAL.gtid_executed' | tr -d '[:space:]')
  [[ "$history" =~ ^[[:xdigit:]:,-]*$ ]] || { echo 'invalid replica GTID set' >&2; return 1; }
  mapfile -t batches < <(find "$OUTPUT_DIR/deltas" -mindepth 1 -maxdepth 1 -type d | sort)
  # Stored earlier deltas can bridge a gap after source MySQL expires its files.
  # Validate the entire chain without changing MySQL or choosing transactions.
  for batch in "${batches[@]}"; do
    [[ ! -f "$batch/.replayed" ]] || continue
    [[ -f "$batch/coverage.json" ]] || continue
    if [[ -f "$OUTPUT_DIR/restored-schemas" ]]; then
      [[ $(jq -c '.schemas | sort' "$batch/coverage.json") == "$(cat "$OUTPUT_DIR/restored-schemas")" ]] || {
        echo 'delta schema selection is incompatible with the restored baseline' >&2; return 1;
      }
    fi
    start=$(jq -r .gtid_start "$batch/coverage.json")
    finish=$(jq -r .gtid_end "$batch/coverage.json")
    [[ "$start" =~ ^[[:xdigit:]:,-]*$ && "$finish" =~ ^[[:xdigit:]:,-]*$ ]] || { echo 'invalid delta GTID set' >&2; return 1; }
    [[ $(mysql "${mysql_args[@]}" "SELECT GTID_SUBSET('$start', '$history')") == 1 ]] || {
      echo 'delta GTID coverage has a gap; waiting for missing deltas' >&2; return 1;
    }
    history=$(mysql "${mysql_args[@]}" "SELECT GTID_SUBTRACT(CONCAT_WS(',', NULLIF('$history',''), NULLIF('$finish','')), '')" | tr -d '[:space:]')
  done
}

restore_baseline() {
  BASELINE_DIR=${BASELINE_DIR:-$(cat "$OUTPUT_DIR/baseline-path")}
  if [[ -f "$(dirname "$BASELINE_DIR")/s3-prefix" ]]; then
    export BASELINE_METADATA_FILE="$BASELINE_DIR/@.json"
    BASELINE_DIR="$(cat "$(dirname "$BASELINE_DIR")/s3-prefix")/baseline"
    export BASELINE_STORAGE=s3
  fi
  export BASELINE_DIR
  mysql-import-baseline.js
  # A replaced database must replay stored batches again. Markers are only a
  # local optimization; MySQL remains responsible for transaction deduplication.
  find "$OUTPUT_DIR/deltas" -name .replayed -type f -delete
  jq -c '.schemas | sort' "${BASELINE_METADATA_FILE:-$BASELINE_DIR/@.json}" > "$OUTPUT_DIR/restored-schemas"
  echo 'restore complete'
}

replay_batches() {
  # Failures retain their files and stop the queue. Successful batches are marked
  # locally, so the storage remains useful for explicit recovery or replays.
  mapfile -t batches < <(find "$OUTPUT_DIR/deltas" -mindepth 1 -maxdepth 1 -type d | sort)
  for batch in "${batches[@]}"; do
    [[ ! -f "$batch/.replayed" ]] || continue
    if [[ -f "$batch/s3-prefix" ]]; then
      : "${S3_BUCKET:?}"

      mkdir -p "$batch/download/delta"
      # Download only this pending batch; preserve it if replay fails.
      while IFS=$'\t' read -r digest size filename object_key; do
        [[ "$filename" =~ ^delta/[^/]+\.[0-9]+$ ]] || { echo 'invalid binlog filename' >&2; return 1; }
        local_file="$batch/download/$filename"
        if [[ ! -f "$local_file" ]]; then
          s3 cp "s3://$S3_BUCKET/$object_key" "$local_file.partial" --only-show-errors
          [[ "$(sha256sum "$local_file.partial" | cut -d ' ' -f 1)" == "${digest#sha256:}" ]] || { echo 'S3 binlog digest mismatch' >&2; return 1; }
          mv "$local_file.partial" "$local_file"
        fi
      done < "$batch/layers.tsv"
      delta_dir="$batch/download/delta"
    else
      delta_dir="$batch/delta"
    fi
    if ! DELTA_DIR="$delta_dir" mysql-import-binlogs.sh; then
      echo "delta replay failed: $batch; retained for retry" >&2
      return 1
    fi
    touch "$batch/.replayed"
    [[ ! -f "$batch/s3-prefix" ]] || rm -rf "$batch/download"
  done
  echo 'replay complete'
}

if [[ "$mode" == restore ]]; then
  restore_baseline
  exit
fi
if [[ "$mode" == all && -n "${BASELINE_TAG:-}" && -z "${MANIFEST_REPO:-}" ]]; then
  restore_baseline
elif [[ "$mode" != replay ]]; then
  if [[ -f "$OUTPUT_DIR/baseline-path" ]]; then
    baseline=$(cat "$OUTPUT_DIR/baseline-path")
    schemas=$(jq -c '.schemas | sort' "$baseline/@.json")
    export MYSQL_PWD="$MYSQL_PASSWORD"
    count=$(mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','sys','performance_schema','information_schema')")
    if [[ "$count" == 0 || ! -f "$OUTPUT_DIR/restored-schemas" || "$schemas" != "$(cat "$OUTPUT_DIR/restored-schemas")" ]]; then
      restore_baseline
    fi
  fi
fi
check_coverage
replay_batches
echo 'import complete'
