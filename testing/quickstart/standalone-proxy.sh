#!/usr/bin/env bash
# Install only the proxy-party chart against the already running demo services.
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
helm upgrade --install standalone-proxy charts/outproxy-with-faucet \
  --namespace quickstart \
  --set-string "outproxyImage=$IMAGE_PREFIX/outproxy:$IMAGE_TAG,cashierImage=$IMAGE_PREFIX/cashier:$IMAGE_TAG" \
  --set cashier.existingSecret=quickstart-cashier \
  --set outproxyExistingSecret=quickstart-outproxy \
  --set-string cashierAccountSalt=quickstart-cashier-account \
  --set tls.existingProxySecret=quickstart-proxy-tls \
  --wait --timeout 3m
QUICKSTART_PROXY_URL=http://standalone-proxy:8080 bash testing/quickstart/quickstart-read.sh
