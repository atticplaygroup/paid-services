#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
: "${KUBECONFIG:?}"
work=$(mktemp -d)
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; rm -rf "$work"; }
trap cleanup EXIT
for route in 'realworld-payments realworld-exchange-envoy 18182:8080' 'puller-ns realworld-replica-envoy 18183:8080' 'index-ns index-envoy 18184:8080' 'storage-provider-ns storage-provider-envoy 18185:8080'; do
  read -r namespace service mapping <<< "$route"
  kubectl -n "$namespace" port-forward --address 127.0.0.1 "svc/$service" "$mapping" > "$work/$service.log" 2>&1 &
  pids+=("$!")
done
python3 - <<'PY'
import socket,time
for port in [18182,18183,18184,18185]:
 deadline=time.monotonic()+30
 while True:
  try:
   with socket.create_connection(('127.0.0.1',port),timeout=1):break
  except OSError:
   if time.monotonic()>deadline:raise
   time.sleep(.1)
PY
for pid in "${pids[@]}"; do
  if ! kill -0 "$pid" 2>/dev/null; then cat "$work/"*.log; exit 1; fi
done
kubectl -n puller-ns get configmap realworld-fixture -o jsonpath='{.data.fixture\.json}' > "$work/config.json"
kubectl -n puller-ns get secret e2e-dpop-keys -o json | python3 -c 'import base64,json,sys,pathlib; x=json.load(sys.stdin); directory=pathlib.Path(sys.argv[1]); [(directory/k).write_bytes(base64.b64decode(v)) for k,v in x["data"].items()]' "$work"
# Linux runner: Chromium reaches the localhost forwards using host networking.
docker run --rm --network host --workdir /app --entrypoint bun \
  -v "$work:/run/realworld:ro" -e E2E_DPOP_KEY_DIR=/run/realworld -e REALWORLD_CONFIG_FILE=/run/realworld/config.json \
  "$IMAGE_PREFIX/realworld:$IMAGE_TAG" test testing/realworld/e2e-payments.test.ts
