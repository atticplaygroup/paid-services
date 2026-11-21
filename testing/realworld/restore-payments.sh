#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${KUBECONFIG:?}"
if ! kubectl -n realworld-payments get secret realworld-phase1-values >/dev/null 2>&1; then exit 0; fi
work=$(mktemp -d)
cleanup() { python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$work"; }
trap cleanup EXIT
kubectl -n realworld-payments get secret realworld-phase1-values -o json | python3 -c 'import base64,json,sys,pathlib; x=json.load(sys.stdin); directory=pathlib.Path(sys.argv[1]); [(directory/k).write_bytes(base64.b64decode(v)) for k,v in x["data"].items()]' "$work"
for entry in 'realworld-replica puller-ns mysql-replica' 'index index-ns index' 'storage-provider storage-provider-ns kvstore'; do
  read -r release namespace chart <<< "$entry"
  helm upgrade "$release" "charts/$chart" -n "$namespace" --reset-values -f "$work/$release.json" --wait --timeout=3m
done
