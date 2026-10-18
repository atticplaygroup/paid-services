#!/usr/bin/env bash
# Build, deploy, and verify a standalone demo using only this repository.
set -euo pipefail
cd "$(dirname "$0")/../.."
export CLUSTER_NAME=${CLUSTER_NAME:-paid-quickstart}
export KUBECONFIG=${KUBECONFIG:-$PWD/testing/quickstart/.kubeconfig}
for tool in docker kind kubectl helm rg jq; do command -v "$tool" >/dev/null; done
if kind get clusters | rg -qx "$CLUSTER_NAME"; then
  kind export kubeconfig --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
else
  kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.34.0
fi
if [[ ${BUILD_IMAGES:-true} == true ]]; then
  bash testing/quickstart/build.sh
fi
bash testing/quickstart/quickstart-kind.sh "$@"
bash testing/quickstart/quickstart.sh
bash testing/quickstart/quickstart-read.sh
printf 'Demo ready. Use: export KUBECONFIG=%q\n' "$KUBECONFIG"
