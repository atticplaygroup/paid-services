#!/usr/bin/env bash
# Only OCI integration namespaces belong to this suite.
set -uo pipefail
for namespace in storage-provider-ns oci-provider-ns pusher-ns puller-ns; do
  kubectl -n "$namespace" get pods,jobs,events -o wide || true
  kubectl -n "$namespace" describe pods || true
  for pod in $(kubectl -n "$namespace" get pods -o name); do
    kubectl -n "$namespace" logs "$pod" --all-containers --tail=200 || true
  done
done
