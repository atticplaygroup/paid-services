#!/usr/bin/env bash
set -uo pipefail
bash testing/oci/diagnostics.sh
for namespace in index-ns dead-low-ns dead-high-ns; do
  kubectl -n "$namespace" get pods,jobs,events -o wide || true
  kubectl -n "$namespace" describe pods || true
  for pod in $(kubectl -n "$namespace" get pods -o name); do kubectl -n "$namespace" logs "$pod" --all-containers --tail=200 || true; done
done
