#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
kubectl -n puller-ns delete job e2e-realworld --ignore-not-found
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/realworld/test-job.yaml | kubectl create -f -
for ((attempt=0; attempt<480; attempt++)); do
  conditions=$(kubectl -n puller-ns get job e2e-realworld -o jsonpath='{.status.conditions[*].type}')
  if [[ $conditions == *Complete* ]]; then kubectl -n puller-ns logs job/e2e-realworld; exit 0; fi
  if [[ $conditions == *Failed* ]]; then kubectl -n puller-ns logs job/e2e-realworld; exit 1; fi
  sleep 5
done
kubectl -n puller-ns logs job/e2e-realworld
exit 1
