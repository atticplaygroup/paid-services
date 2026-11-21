#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/routing/test-job.yaml | kubectl create -f -
bash testing/routing/wait-job.sh puller-ns e2e-routing
