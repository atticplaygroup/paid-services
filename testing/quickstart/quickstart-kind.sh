#!/usr/bin/env bash
# Deploy to a cluster already created by helm/kind-action (or kind locally).
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
: "${CLUSTER_NAME:?Set CLUSTER_NAME to the existing kind cluster}"
: "${KUBECONFIG:?Set KUBECONFIG to the cluster kubeconfig}"
QUICKSTART_IMAGE_DIR=$(mktemp -d)
trap 'rm -rf "$QUICKSTART_IMAGE_DIR"' EXIT
QUICKSTART_NODE_PLATFORM="linux/$(docker version --format '{{.Server.Arch}}')"
for image in "$IMAGE_PREFIX/s3-retention-rules:$IMAGE_TAG" "$IMAGE_PREFIX/infrastructure:$IMAGE_TAG" "$IMAGE_PREFIX/outproxy:$IMAGE_TAG" "$IMAGE_PREFIX/cashier:$IMAGE_TAG" chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d envoyproxy/envoy:v1.33.0 valkey/valkey:8-alpine postgres:16-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  # Export only the node platform; containerd image indexes may include unpulled platforms.
  docker save --platform "$QUICKSTART_NODE_PLATFORM" -o "$QUICKSTART_IMAGE_DIR/image.tar" "$image"
  kind load image-archive "$QUICKSTART_IMAGE_DIR/image.tar" --name "$CLUSTER_NAME"
done
helm dependency build charts/kvstore
helm dependency build charts/exchange
helm dependency build testing/quickstart/chart
quickstart_extra_values=()
if [[ ${CI_EMPTY_WALLET:-false} == true ]]; then
  # A fresh mnemonic prevents earlier demo/CI funding from masking lazy funding.
  docker run --rm --entrypoint bun "$IMAGE_PREFIX/cashier:$IMAGE_TAG" -e '
    import { generateMnemonic } from "@scure/bip39";
    import { wordlist } from "@scure/bip39/wordlists/english.js";
    console.log(JSON.stringify({proxy: {cashier: {walletMnemonic: generateMnemonic(wordlist)}}}));
  ' > "$QUICKSTART_IMAGE_DIR/wallet-values.json"
  quickstart_extra_values=(-f "$QUICKSTART_IMAGE_DIR/wallet-values.json")
fi
helm upgrade --install quickstart testing/quickstart/chart \
  --namespace quickstart --create-namespace -f testing/quickstart/quickstart-values.yaml \
  --set-string "proxy.outproxyImage=$IMAGE_PREFIX/outproxy:$IMAGE_TAG,proxy.cashierImage=$IMAGE_PREFIX/cashier:$IMAGE_TAG" \
  --set-string "provider.image.repository=$IMAGE_PREFIX/infrastructure,provider.image.tag=$IMAGE_TAG,provider.meter.image.repository=$IMAGE_PREFIX/infrastructure,provider.meter.image.tag=$IMAGE_TAG" \
  --set-string "provider.s3.retentionRules.image.repository=$IMAGE_PREFIX/s3-retention-rules,provider.s3.retentionRules.image.tag=$IMAGE_TAG" \
  --set-string "exchange.image.repository=$IMAGE_PREFIX/infrastructure,exchange.image.tag=$IMAGE_TAG,exchange.meter.image.repository=$IMAGE_PREFIX/infrastructure,exchange.meter.image.tag=$IMAGE_TAG" \
  "${quickstart_extra_values[@]}" "$@" --timeout 10m
kubectl -n quickstart rollout status statefulset/quickstart-postgres --timeout=180s
kubectl -n quickstart rollout status deployment --timeout=300s
bash testing/shared/reconcile-retention.sh quickstart quickstart-provider-s3-retention-rules
