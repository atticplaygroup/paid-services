#!/bin/bash
# Download artifacts independently of MySQL. Only atomic directory renames
# expose completed downloads to restore/replay consumers.
set -euo pipefail
aws_s3() {
  local args=(--region "${AWS_REGION:-us-east-1}")
  [[ -z "${S3_ENDPOINT:-}" ]] || args+=(--endpoint-url "$S3_ENDPOINT")
  aws "${args[@]}" "$@"
}
s3() { aws_s3 s3 "$@"; }
artifact_layers() {
  local manifest=$1 kind=$2
  jq -e --arg kind "$kind" '
    .layers | length > 0 and all(.[];
      (.digest | test("^sha256:[a-f0-9]{64}$")) and
      (.size | type == "number" and . >= 0) and
      (.annotations["org.opencontainers.image.title"] |
        startswith($kind + "/") and (split("/") | all(.[]; . != ".." and . != ""))))
  ' "$manifest" >/dev/null || { echo 'invalid OCI file layers' >&2; return 1; }
  jq -r '.layers[] | [.digest, (.size | tostring), .annotations["org.opencontainers.image.title"]] | @tsv' "$manifest"
}
s3_upload_artifact() {
  local repo=$1 tag=$2 kind=$3 key=$4 destination=$5
  local prefix="${S3_PREFIX:-mysql}/${kind}s/$key"
  local manifest="$stage/$kind-manifest.json"
  oras manifest fetch --plain-http "$OCI_ADDRESS/$repo:$tag" > "$manifest"
  mkdir -p "$stage/$kind"
  artifact_layers "$manifest" "$kind" > "$stage/layers.tsv"
  while IFS=$'\t' read -r digest size filename; do
    object_key="$prefix/$filename"
    if [[ "$kind" == delta ]]; then
      [[ "$filename" =~ ^delta/[^/]+\.[0-9]+$ ]] || { echo 'invalid binlog filename' >&2; return 1; }
      object_key="${S3_PREFIX:-mysql}/binlogs/${digest#sha256:}/${filename#delta/}"
      completed="$OUTPUT_DIR/.synced/$(printf '%s\n' "$S3_BUCKET" "${S3_ENDPOINT:-}" "$object_key" | sha256sum | cut -d ' ' -f 1)"
    fi
    printf '%s\t%s\t%s\t%s\n' "$digest" "$size" "$filename" "$object_key" >> "$stage/$kind/layers.tsv"
    if [[ "$kind" == delta && -f "$completed" ]] &&
        [[ $(aws_s3 s3api head-object --bucket "$S3_BUCKET" --key "$object_key" --query ContentLength --output text) == "$size" ]]; then
      continue
    fi
    # Stream large layers without local copies. Verify their digest before
    # making the completed artifact visible to consumers.
    mkfifo "$stage/hash-pipe"
    sha256sum < "$stage/hash-pipe" > "$stage/hash" &
    hash_pid=$!
    if ! oras blob fetch --plain-http --output - "$OCI_ADDRESS/$repo@$digest" |
        tee "$stage/hash-pipe" |
        s3 cp - "s3://$S3_BUCKET/$object_key" --expected-size "$size" --only-show-errors; then
      wait "$hash_pid" || true
      rm -f "$stage/hash-pipe"
      return 1
    fi
    wait "$hash_pid"
    rm "$stage/hash-pipe"
    [[ "$(cut -d ' ' -f 1 "$stage/hash")" == "${digest#sha256:}" ]] || { echo "OCI digest mismatch: $filename" >&2; return 1; }
    [[ "$kind" != delta ]] || touch "$completed"
  done < "$stage/layers.tsv"
  printf '%s\n' "$prefix" > "$stage/$kind/s3-prefix"
  if [[ "$kind" == baseline ]]; then
    mkdir -p "$stage/$kind/baseline"
    for file in @.json @.done.json; do
      s3 cp "s3://$S3_BUCKET/$prefix/baseline/$file" "$stage/$kind/baseline/$file" --only-show-errors
    done
  fi
  # Completion is committed last in S3 as well as in the local queue.
  s3 cp "$manifest" "s3://$S3_BUCKET/$prefix/.complete.json" --only-show-errors
  [[ "$kind" != delta ]] || cp "$stage/coverage.json" "$stage/$kind/coverage.json"
  mv "$stage/$kind" "$destination"
}

: "${OCI_ADDRESS:?}" "${OUTPUT_DIR:?}"
STORAGE_MODE=${STORAGE_MODE:-filesystem}
[[ "$STORAGE_MODE" == filesystem || "$STORAGE_MODE" == s3 ]] || { echo 'invalid storage mode' >&2; exit 1; }
if [[ "$STORAGE_MODE" == s3 ]]; then
  : "${S3_BUCKET:?}"
  s3 ls "s3://$S3_BUCKET" >/dev/null 2>&1 || s3 mb "s3://$S3_BUCKET"
fi
mkdir -p "$OUTPUT_DIR"/{baselines,deltas,.staging,.synced,.files}
exec 8>"$OUTPUT_DIR/.sync.lock"
flock -n 8 || exit 0
stage=$(mktemp -d "$OUTPUT_DIR/.staging/pull.XXXXXX")
trap 'rm -rf "$stage"' EXIT
if [[ -n "${MANIFEST_REPO:-}" ]]; then
  : "${APPLICATION:?}"
  tag=$(oras repo tags --plain-http "$OCI_ADDRESS/$MANIFEST_REPO" | awk '/^[0-9]{23}$/' | sort | tail -n 1)
  [[ -n "$tag" ]] || { echo 'no timestamp-tagged application manifests found' >&2; exit 1; }
  oras pull --plain-http "$OCI_ADDRESS/$MANIFEST_REPO:$tag" -o "$stage/manifest"
  yq -o=json '.' "$stage/manifest/application-manifest.yaml" > "$stage/manifest.json"
  jq -e --arg application "$APPLICATION" --arg tag "$tag" --arg owner "${APPLICATION_OWNER:-}" '
    .version == "v1" and .application == $application and .tag == $tag and
    ($owner == "" or .owner == $owner)
  ' "$stage/manifest.json" >/dev/null || { echo 'application manifest does not match subscription' >&2; exit 1; }
  jq -e --arg application "$APPLICATION" '
    [.databases[] | select(.name == $application)] |
    if length == 1 then .[0] else error("expected one selected database") end
  ' "$stage/manifest.json" > "$stage/database.json"
  jq -e '
    .type == "mysql:v26.5.3" and
    (.exported_schemas | type == "array" and length > 0 and all(.[]; type == "string")) and
    ([.baseline.repo, .delta.repo] | all(.[]; type == "string" and test("^[a-z0-9][a-z0-9._/-]*$"))) and
    (.tag | type == "string" and test("^[0-9]{23}$")) and
    ([.baseline.tag, .delta.tag] | all(.[]; type == "string" and test("^[0-9]{23}$")))
  ' "$stage/database.json" >/dev/null || { echo 'invalid database manifest' >&2; exit 1; }
  BASELINE_REPO=$(jq -r .baseline.repo "$stage/database.json")
  BASELINE_TAG=$(jq -r .baseline.tag "$stage/database.json")
  DELTA_REPO=$(jq -r .delta.repo "$stage/database.json")
  DELTA_TAG=$(jq -r .delta.tag "$stage/database.json")
fi
for kind in baseline delta; do
  if [[ "$kind" == baseline ]]; then
    repo=${BASELINE_REPO:-}; tag=${BASELINE_TAG:-}; collection=baselines
  else
    repo=${DELTA_REPO:-}; tag=${DELTA_TAG:-}; collection=deltas
  fi
  [[ -n "$tag" ]] || continue
  : "${repo:?repository required}"
  [[ "$tag" =~ ^[0-9]{23}$ && "$repo" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || { echo 'invalid artifact reference' >&2; exit 1; }
  # A new state tag can reuse the same artifact. Store its files only once.
  digest=$(oras resolve --plain-http "$OCI_ADDRESS/$repo:$tag")
  storage_id=$(printf '%s\n' "$STORAGE_MODE" "${S3_BUCKET:-}" "${S3_PREFIX:-}" "${S3_ENDPOINT:-}" "$repo" "$digest" | sha256sum | cut -c1-16)
  key="$tag-$storage_id"
  destination=$(find "$OUTPUT_DIR/$collection" -mindepth 1 -maxdepth 1 -type d -name "*-$storage_id" | sort | head -n 1)
  destination=${destination:-"$OUTPUT_DIR/$collection/$key"}
  if [[ ! -d "$destination" ]]; then
    if [[ "$kind" == delta ]]; then
      if [[ -f "$stage/database.json" ]]; then
        jq -e '
          {gtid_start:.delta.gtid_start, gtid_end:.delta.gtid_end, schemas:.exported_schemas} |
          if ([.gtid_start,.gtid_end] | all(.[]; type == "string" and test("^[a-fA-F0-9:,-]*$")))
          then . else error("invalid delta coverage") end
        ' "$stage/database.json" > "$stage/coverage.json"
      else
      oras manifest fetch --plain-http "$OCI_ADDRESS/$repo:$tag" > "$stage/delta-descriptor.json"
      jq -e '
        .annotations as $a |
        {gtid_start:$a["org.paid.mysql.gtid-start"],gtid_end:$a["org.paid.mysql.gtid-end"],
         schemas:($a["org.paid.mysql.exported-schemas"] | split(","))} |
        if ([.gtid_start,.gtid_end] | all(.[]; type == "string" and test("^[a-fA-F0-9:,-]*$")))
        then . else error("invalid delta coverage") end
      ' "$stage/delta-descriptor.json" > "$stage/coverage.json"
      fi
    fi
    if [[ "$STORAGE_MODE" == s3 ]]; then
      s3_upload_artifact "$repo" "$tag" "$kind" "$key" "$destination"
    elif [[ "$kind" == delta ]]; then
      oras manifest fetch --plain-http "$OCI_ADDRESS/$repo:$tag" > "$stage/delta-manifest.json"
      mkdir -p "$stage/delta/delta"
      artifact_layers "$stage/delta-manifest.json" delta > "$stage/delta/layers.tsv"
      while IFS=$'\t' read -r digest size filename; do
        [[ "$filename" =~ ^delta/[^/]+\.[0-9]+$ ]] || { echo 'invalid binlog filename' >&2; exit 1; }
        stored="$OUTPUT_DIR/.files/${digest#sha256:}"
        if [[ ! -f "$stored" ]]; then
          oras blob fetch --plain-http --output "$stage/file" "$OCI_ADDRESS/$repo@$digest"
          [[ "$(sha256sum "$stage/file" | cut -d ' ' -f 1)" == "${digest#sha256:}" ]] || { echo 'OCI binlog digest mismatch' >&2; exit 1; }
          mv "$stage/file" "$stored"
        fi
        ln "$stored" "$stage/delta/$filename"
      done < "$stage/delta/layers.tsv"
      cp "$stage/coverage.json" "$stage/delta/coverage.json"
      mv "$stage/delta" "$destination"
    else
      oras pull --plain-http "$OCI_ADDRESS/$repo:$tag" -o "$stage/$kind"
      if [[ "$kind" == baseline ]]; then
        [[ -f "$stage/$kind/baseline/@.done.json" && -f "$stage/$kind/baseline/@.json" ]] || { echo 'incomplete baseline dump' >&2; exit 1; }
      else
        find "$stage/$kind/delta" -maxdepth 1 -type f -regextype posix-extended -regex '.*\.[0-9]+' -print -quit | read -r _ || { echo 'missing delta binlogs' >&2; exit 1; }
      fi
      [[ "$kind" != delta ]] || cp "$stage/coverage.json" "$stage/$kind/coverage.json"
      mv "$stage/$kind" "$destination"
    fi
  fi
  if [[ "$kind" == baseline ]]; then
    printf '%s\n' "$destination/baseline" > "$stage/baseline-path"
    mv "$stage/baseline-path" "$OUTPUT_DIR/baseline-path"
  fi
done
echo 'sync complete'
