#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/mysql/test-job.yaml | kubectl create -f -
for ((attempt=0; attempt<125; attempt++)); do
  MYSQL_JOB_CONDITIONS=$(kubectl -n proposer-ns get job e2e-mysql -o jsonpath='{.status.conditions[*].type}')
  if [[ $MYSQL_JOB_CONDITIONS == *Complete* ]]; then
    kubectl -n proposer-ns logs job/e2e-mysql
    exit 0
  fi
  if [[ $MYSQL_JOB_CONDITIONS == *Failed* ]]; then
    kubectl -n proposer-ns logs job/e2e-mysql --all-containers=true || true
    kubectl -n proposer-ns describe job e2e-mysql
    exit 1
  fi
  sleep 5
done
kubectl -n proposer-ns logs job/e2e-mysql --all-containers=true || true
echo 'MySQL test Job did not complete within its deadline' >&2
exit 1
