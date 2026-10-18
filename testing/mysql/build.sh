#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
docker build -t "$IMAGE_PREFIX/mysql-tools:$IMAGE_TAG" -f docker/mysql-tools.Dockerfile .
docker build -t "$IMAGE_PREFIX/mysql-test-client:$IMAGE_TAG" --build-arg "MYSQL_TOOLS_IMAGE=$IMAGE_PREFIX/mysql-tools:$IMAGE_TAG" -f testing/mysql/Dockerfile.client .
