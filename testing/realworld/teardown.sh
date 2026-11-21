#!/usr/bin/env bash
set -euo pipefail
: "${CLUSTER_NAME:?Set the dedicated test cluster name}"
kind delete cluster --name "$CLUSTER_NAME"
