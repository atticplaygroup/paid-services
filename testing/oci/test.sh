#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$OCI_IMAGE_TAG/g" testing/oci/test-job.yaml | kubectl create -f -
# Inspect terminal failure as well as completion; never retry a failed suite.
for ((attempt=0; attempt<125; attempt++)); do
  OCI_JOB_CONDITIONS=$(kubectl -n puller-ns get job e2e-oci -o jsonpath='{.status.conditions[*].type}')
  if [[ $OCI_JOB_CONDITIONS == *Complete* ]]; then
    kubectl -n puller-ns logs job/e2e-oci
    exit 0
  fi
  if [[ $OCI_JOB_CONDITIONS == *Failed* ]]; then
    kubectl -n puller-ns logs job/e2e-oci --all-containers=true || true
    kubectl -n puller-ns describe job e2e-oci
    exit 1
  fi
  sleep 5
done
kubectl -n puller-ns logs job/e2e-oci --all-containers=true || true
echo 'OCI test Job did not complete within its deadline' >&2
exit 1
