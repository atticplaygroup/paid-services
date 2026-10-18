#!/usr/bin/env bash
# Run against an installed independent quickstart-demo release.
set -euo pipefail
NAMESPACE=${NAMESPACE:-quickstart}
RELEASE=${RELEASE:-quickstart}
JOB="$RELEASE-seed-$(date +%s)"
kubectl -n "$NAMESPACE" create job "$JOB" --from="cronjob/$RELEASE-seed"
# Watch the specific job, including terminal failure, while the seed performs
# real devnet funding, exchange purchase/redemption, upload and both reads.
for ((attempt=0; attempt<180; attempt++)); do
  result=$(kubectl -n "$NAMESPACE" get job "$JOB" -o jsonpath='{.status.conditions[*].type}')
  if [[ $result == *Complete* ]]; then
    kubectl -n "$NAMESPACE" logs "job/$JOB"
    exit 0
  fi
  if [[ $result == *Failed* ]]; then
    kubectl -n "$NAMESPACE" logs "job/$JOB" --all-containers=true
    kubectl -n "$NAMESPACE" describe job "$JOB"
    exit 1
  fi
  sleep 5
done
kubectl -n "$NAMESPACE" logs "job/$JOB" --all-containers=true
printf 'Seed job did not complete: %s\n' "$JOB" >&2
exit 1
