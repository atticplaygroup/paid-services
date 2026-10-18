#!/usr/bin/env bash
# The public reader needs only curl and the proxy CA; assert the exact decoded bytes.
set -euo pipefail
cd "$(dirname "$0")/../.."
QUICKSTART_PROXY_URL=${QUICKSTART_PROXY_URL:-http://quickstart:8080}
quickstart_proxy_options=()
OUTPUT=$(mktemp)
trap 'rm -f "$OUTPUT"; kubectl -n quickstart delete pod quickstart-reader --ignore-not-found >/dev/null' EXIT
kubectl -n quickstart run quickstart-reader --image=alpine:3.22 --restart=Never --command -- sleep 3600
kubectl -n quickstart wait --for=condition=Ready pod/quickstart-reader --timeout=120s
kubectl -n quickstart exec quickstart-reader -- apk add --no-cache curl
kubectl -n quickstart get secret quickstart-proxy-tls -o jsonpath='{.data.ca\.crt}' | base64 -d | \
  kubectl -n quickstart exec -i quickstart-reader -- sh -c 'cat > /tmp/ca.crt'
if [[ $QUICKSTART_PROXY_URL == https://* ]]; then
  : "${QUICKSTART_PROXY_CA_SECRET:?Set QUICKSTART_PROXY_CA_SECRET to the Secret containing the proxy TLS trust certificate}"
  QUICKSTART_PROXY_CA_KEY=${QUICKSTART_PROXY_CA_KEY:-ca.crt}
  kubectl -n quickstart get secret "$QUICKSTART_PROXY_CA_SECRET" -o json \
    | jq -er --arg key "$QUICKSTART_PROXY_CA_KEY" '.data[$key]' | base64 -d \
    | kubectl -n quickstart exec -i quickstart-reader -- sh -c 'cat > /tmp/proxy-ca.crt'
  quickstart_proxy_options=(--proxy-cacert /tmp/proxy-ca.crt)
fi
kubectl -n quickstart exec quickstart-reader -- curl \
  --proxy "$QUICKSTART_PROXY_URL" "${quickstart_proxy_options[@]}" \
  --cacert /tmp/ca.crt --fail-with-body -sS --noproxy '' \
  --connect-timeout 15 --max-time 120 \
  -H 'content-type: application/json' \
  -H "x-request-id: $(< /proc/sys/kernel/random/uuid)" \
  -d '{"key":"bafkreihfqce2w5fkfwct23alewvtt56pwg7yzeayg4tfhjme57ie44qbam"}' \
  https://quickstart-provider-envoy:8443/kvstore.v1.MeteredStorageService/GetCASValue \
  | jq -er .value | base64 -d > "$OUTPUT"
cmp testing/quickstart/chart/files/welcome.txt "$OUTPUT"
cat "$OUTPUT"
