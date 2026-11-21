#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/routing/build.sh
docker build -t "$IMAGE_PREFIX/browser-test-client:$IMAGE_TAG" -f testing/browser/Dockerfile .
