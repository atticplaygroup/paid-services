#!/usr/bin/env bash
set -euo pipefail
namespace=$1
cronjob=$2
job="$cronjob-check"
kubectl -n "$namespace" delete job "$job" --ignore-not-found
kubectl -n "$namespace" create job "$job" --from="cronjob/$cronjob"
if ! kubectl -n "$namespace" wait --for=condition=Complete "job/$job" --timeout=180s; then
  kubectl -n "$namespace" logs "job/$job" --all-containers=true || true
  exit 1
fi
kubectl -n "$namespace" logs "job/$job"
