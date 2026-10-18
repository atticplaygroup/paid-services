#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${IMAGE_PREFIX:=ghcr.io/atticplaygroup/paid-services}"
: "${IMAGE_TAG:?Set IMAGE_TAG to a release version or a commit-specific development tag}"
: "${IMAGE_NAME:?Set IMAGE_NAME to a PAID image name}"
case "$IMAGE_NAME" in infrastructure|cashier|outproxy|oci|mysql-tools|s3-retention-rules) ;; *) echo 'Unknown PAID image' >&2; exit 1 ;; esac
[[ $IMAGE_PREFIX =~ ^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$ ]] || { echo 'Invalid IMAGE_PREFIX' >&2; exit 1; }
[[ $IMAGE_TAG =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$ ]] || { echo 'Invalid IMAGE_TAG' >&2; exit 1; }
reference="$IMAGE_PREFIX/$IMAGE_NAME:$IMAGE_TAG"
docker build --platform linux/amd64 -t "$reference" -f "docker/$IMAGE_NAME.Dockerfile" .
if [[ ${PUBLISH_IMAGES:-false} == true ]]; then
  # Released version tags must never be overwritten.
  if [[ $IMAGE_TAG == v* ]]; then
    if docker manifest inspect "$reference" >/dev/null 2>&1; then
      echo "Release image already exists: $reference" >&2
      exit 1
    fi
  fi
  docker push "$reference"
  if [[ ${DEVELOPMENT_ALIAS:-} == main ]]; then
    docker tag "$reference" "$IMAGE_PREFIX/$IMAGE_NAME:main"
    docker push "$IMAGE_PREFIX/$IMAGE_NAME:main"
  fi
fi
