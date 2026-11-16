#!/usr/bin/env bash
set -euo pipefail
namespace=$1
job=$2
for ((attempt=0; attempt<75; attempt++)); do
  conditions=$(kubectl -n "$namespace" get job "$job" -o jsonpath='{.status.conditions[*].type}')
  if [[ $conditions == *Complete* ]]; then kubectl -n "$namespace" logs "job/$job"; exit 0; fi
  if [[ $conditions == *Failed* ]]; then kubectl -n "$namespace" logs "job/$job" --all-containers=true; exit 1; fi
  sleep 5
done
kubectl -n "$namespace" logs "job/$job" --all-containers=true || true
exit 1
