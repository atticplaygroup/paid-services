#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
helm uninstall proposer -n proposer-ns --ignore-not-found
helm uninstall replica -n replica-ns --ignore-not-found
kubectl delete all -n registry-system --all --ignore-not-found
kubectl delete namespace registry-system --ignore-not-found
