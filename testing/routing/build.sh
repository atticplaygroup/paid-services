#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/oci/build.sh
docker build -t "$IMAGE_PREFIX/routing-test-client:$IMAGE_TAG" -f testing/routing/Dockerfile.client .
