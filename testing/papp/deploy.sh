#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/routing/deploy.sh
bash testing/shared/load-image.sh "$IMAGE_PREFIX/papp-framework:$IMAGE_TAG"
