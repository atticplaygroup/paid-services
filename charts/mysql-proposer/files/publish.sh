#!/bin/bash
set -euo pipefail
publish_artifact() (
  : "${OCI_ADDRESS:?}" "${ARTIFACT_REPO:?}" "${ARTIFACT_KIND:?}"
  config=$(mktemp)
  layers=$(mktemp)
  manifest=$(mktemp)
  trap 'rm -f "$config" "$layers" "$manifest"' EXIT
  printf '{}' > "$config"
  oras blob push --plain-http --descriptor --media-type application/vnd.oci.empty.v1+json \
    "$OCI_ADDRESS/$ARTIFACT_REPO" "$config" > "$manifest.config"
  trap 'rm -f "$config" "$layers" "$manifest" "$manifest.config"' EXIT
  while IFS= read -r -d '' file; do
    oras blob push --plain-http --descriptor --media-type application/octet-stream \
      "$OCI_ADDRESS/$ARTIFACT_REPO" "$file" |
      jq -c --arg name "$file" '.annotations = {"org.opencontainers.image.title": $name}' >> "$layers"
  done < <(find "$ARTIFACT_KIND" -type f -print0 | sort -z)
  jq -n --arg artifactType "application/vnd.paid.mysql.$ARTIFACT_KIND.v1" \
    --arg start "${ARTIFACT_GTID_START:-}" --arg gtid_end "${ARTIFACT_GTID_END:-}" --arg schemas "$MYSQL_EXPORT_SCHEMAS" \
    --slurpfile config "$manifest.config" --slurpfile layers "$layers" \
    '{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",artifactType:$artifactType,config:$config[0],layers:$layers,annotations:{"org.paid.mysql.gtid-start":$start,"org.paid.mysql.gtid-end":$gtid_end,"org.paid.mysql.exported-schemas":$schemas}}' > "$manifest"
  digest="sha256:$(sha256sum "$manifest" | cut -d ' ' -f 1)"
  oras manifest push --plain-http "$OCI_ADDRESS/$ARTIFACT_REPO@$digest" "$manifest" >&2
  printf '%s\n' "$digest"
)

generate_manifest() (
  : "${PUBLISH_STATE_DIR:?}" "${OCI_ADDRESS:?}" "${MANIFEST_REPO:?}" "${APPLICATION:?}" "${OWNER:?}" "${MYSQL_EXPORT_SCHEMAS:?}"
  if [[ ! -f "$PUBLISH_STATE_DIR/baseline.json" || ! -f "$PUBLISH_STATE_DIR/delta.json" ]]; then
    echo 'manifest pending: waiting for independent baseline and delta publications'
    exit 0
  fi
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cp "$PUBLISH_STATE_DIR/baseline.json" "$work/baseline.json"
  cp "$PUBLISH_STATE_DIR/delta.json" "$work/delta.json"
  mkdir -p "$PUBLISH_STATE_DIR/tags"
  for kind in baseline delta; do
    repo=$(jq -r .repo "$work/$kind.json")
    digest=$(jq -r .digest "$work/$kind.json")
    identity=$(printf '%s\n' "$repo" "$digest" | sha256sum | cut -d ' ' -f 1)
    if [[ -f "$PUBLISH_STATE_DIR/tags/$identity" ]]; then
      tag=$(cat "$PUBLISH_STATE_DIR/tags/$identity")
    else
      tag=$(date -u +%Y%m%d%H%M%S%N)
      oras tag --plain-http "$OCI_ADDRESS/$repo@$digest" "$tag"
      tag_file=$(mktemp "$PUBLISH_STATE_DIR/tags/.tag.XXXXXX")
      printf '%s\n' "$tag" > "$tag_file"
      mv "$tag_file" "$PUBLISH_STATE_DIR/tags/$identity"
    fi
    jq --arg tag "$tag" '. + {tag:$tag}' "$work/$kind.json" > "$work/$kind-tagged.json"
  done
  manifest_tag=$(date -u +%Y%m%d%H%M%S%N)
  jq -n --arg application "$APPLICATION" --arg owner "$OWNER" --arg tag "$manifest_tag" \
    --arg schemas "$MYSQL_EXPORT_SCHEMAS" --slurpfile baseline "$work/baseline-tagged.json" \
    --slurpfile delta "$work/delta-tagged.json" '
    {version:"v1",owner:$owner,application:$application,tag:$tag,
     databases:[{type:"mysql:v26.5.3",name:$application,tag:$tag,
       baseline:($baseline[0] | {repo,tag,gtid_end}),
       delta:($delta[0] | {repo,tag,gtid_start,gtid_end}),exported_schemas:($schemas | split(","))}],storage:[]}
  ' | yq -P '.' > "$work/application-manifest.yaml"
  cd "$work"
  oras push --plain-http "$OCI_ADDRESS/$MANIFEST_REPO:$manifest_tag" \
    --artifact-type application/vnd.paid.mysql.manifest.v1+yaml application-manifest.yaml:application/yaml
  baseline_tag=$(jq -r .tag baseline-tagged.json)
  delta_tag=$(jq -r .tag delta-tagged.json)
  baseline_repo=$(jq -r .repo baseline-tagged.json)
  oras tag --plain-http "$OCI_ADDRESS/$baseline_repo:$baseline_tag" latest
  oras tag --plain-http "$OCI_ADDRESS/$MANIFEST_REPO:$manifest_tag" latest
  echo "publish complete: baseline=$baseline_tag delta=$delta_tag manifest=$manifest_tag"
)

required=(MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_EXPORT_SCHEMAS \
  OCI_ADDRESS BASELINE_REPO DELTA_REPO MANIFEST_REPO APPLICATION OWNER OUTPUT_DIR PUBLISH_STATE_DIR)
for var in "${required[@]}"; do
  [[ -n "${!var:-}" ]] || { echo "missing env: $var" >&2; exit 1; }
done
mode=${PUBLISH_MODE:-baseline}
[[ "$mode" == baseline || "$mode" == delta || "$mode" == manifest ]] || { echo 'invalid publish mode' >&2; exit 1; }
if [[ "$mode" == manifest ]]; then
  generate_manifest
  exit
fi
# Exporters know only the source and their own artifact. Shared publication state
# records completed uploads for the separate manifest generator.
mkdir -p "$OUTPUT_DIR" "$PUBLISH_STATE_DIR"
export_dir=$(mktemp -d "$OUTPUT_DIR/publication.XXXXXX")
trap 'rm -rf "$export_dir"' EXIT
cd "$export_dir"
if [[ "$mode" == baseline ]]; then
  OUTPUT_DIR="$export_dir/baseline" mysql-export-baseline.js
  gtid_end=$(jq -r .gtidExecuted baseline/@.json | tr -d '[:space:]')
  gtid_start=""
  repo=$BASELINE_REPO
  record=$(jq -n --arg repo "$repo" --arg gtid_end "$gtid_end" '{repo:$repo,gtid_end:$gtid_end}')
else
  boundary=$(OUTPUT_DIR="$export_dir/delta" mysql-export-binlogs.sh)
  gtid_start=$(jq -r .gtid_start <<< "$boundary")
  gtid_end=$(jq -r .gtid_end <<< "$boundary")
  repo=$DELTA_REPO
  record=$(jq --arg repo "$repo" '. + {repo:$repo}' <<< "$boundary")
fi
digest=$(ARTIFACT_REPO="$repo" ARTIFACT_KIND="$mode" ARTIFACT_GTID_START="$gtid_start" ARTIFACT_GTID_END="$gtid_end" publish_artifact)
jq --arg digest "$digest" '. + {digest:$digest}' <<< "$record" > "$export_dir/record.json"
# The directory and destination share a filesystem, making the state handoff atomic.
state_file=$(mktemp "$PUBLISH_STATE_DIR/.$mode.XXXXXX")
cp "$export_dir/record.json" "$state_file"
mv "$state_file" "$PUBLISH_STATE_DIR/$mode.json"
echo "artifact published: $mode=$digest"
generate_manifest
