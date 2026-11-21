#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/routing/build.sh
docker build -t "$IMAGE_PREFIX/papp-framework:$IMAGE_TAG" -f testing/papp/Dockerfile .
