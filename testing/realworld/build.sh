#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/routing/build.sh
docker build -t "$IMAGE_PREFIX/mysql-tools:$IMAGE_TAG" -f docker/mysql-tools.Dockerfile .
docker build -t "$IMAGE_PREFIX/realworld:$IMAGE_TAG" -f testing/realworld/Dockerfile .
