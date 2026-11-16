#!/usr/bin/env bash
# Keep multi-GB image archives off RAM-backed /tmp and release them before
# deploying workloads. A subshell keeps cleanup independent of the caller's trap.
set -euo pipefail
: "${CLUSTER_NAME:?Set CLUSTER_NAME to the existing kind cluster}"
: "${1:?Usage: load-image.sh IMAGE}"
image_dir=$(mktemp -d "${IMAGE_ARCHIVE_TMPDIR:-/var/tmp}/paid-image.XXXXXXXX")
trap 'rm -rf "$image_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker image inspect "$1" >/dev/null 2>&1 || docker pull "$1"
# Exclude unpulled platforms retained by Docker's containerd image store.
docker save --platform "linux/$(docker version --format '{{.Server.Arch}}')" -o "$image_dir/image.tar" "$1"
kind load image-archive "$image_dir/image.tar" --name "$CLUSTER_NAME"
