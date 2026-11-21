#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${KUBECONFIG:?}"
work=$(mktemp -d)
chmod 700 "$work"
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$work"; }
trap cleanup EXIT
kubectl -n puller-ns get configmap realworld-fixture -o jsonpath='{.data.fixture\.json}' > "$work/config.json"
kubectl -n puller-ns get secret e2e-dpop-keys -o json | python3 -c 'import base64,json,sys,pathlib; x=json.load(sys.stdin); directory=pathlib.Path(sys.argv[1]); [(directory/k).write_bytes(base64.b64decode(v)) for k,v in x["data"].items()]' "$work"
for route in 'index-ns index-envoy 28080:8080' 'storage-provider-ns storage-provider-envoy 28081:8080' 'puller-ns realworld-replica-envoy 28082:8080' 'pusher-ns realworld-proposer 28083:3000' 'pusher-ns realworld-idp 4000:4000'; do
  read -r namespace service mapping <<< "$route"
  kubectl -n "$namespace" port-forward --address 127.0.0.1 "svc/$service" "$mapping" > "$work/$service.log" 2>&1 &
  pids+=("$!")
done
export E2E_DPOP_KEY_DIR="$work" REALWORLD_CONFIG_FILE="$work/config.json"
# Wait for all port-forwards to bind before publishing localhost advertisements.
python3 - <<'PY'
import socket,time
for port in [28080,28081,28082,28083,4000]:
 deadline=time.monotonic()+30
 while True:
  try:
   with socket.create_connection(('127.0.0.1',port),timeout=1):break
  except OSError:
   if time.monotonic()>deadline:raise
   time.sleep(.1)
PY
bun testing/realworld/launch.ts
