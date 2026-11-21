#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
kubectl -n puller-ns delete job e2e-papp-framework --ignore-not-found
case ${PAPP_BROWSER:-chrome} in chrome|firefox|edge|webkit) ;; *) echo "Unsupported PAPP_BROWSER: $PAPP_BROWSER" >&2; exit 1 ;; esac
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" -e "s/value: chrome/value: ${PAPP_BROWSER:-chrome}/g" testing/papp/test-job.yaml | kubectl create -f -
for ((attempt=0; attempt<180; attempt++)); do
  conditions=$(kubectl -n puller-ns get job e2e-papp-framework -o jsonpath='{.status.conditions[*].type}')
  if [[ $conditions == *Complete* ]]; then kubectl -n puller-ns logs job/e2e-papp-framework; exit 0; fi
  if [[ $conditions == *Failed* ]]; then kubectl -n puller-ns logs job/e2e-papp-framework; exit 1; fi
  sleep 5
done
kubectl -n puller-ns logs job/e2e-papp-framework
exit 1
