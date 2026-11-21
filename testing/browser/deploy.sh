#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
if [[ ${1:-} != --reuse-routing ]]; then
  bash testing/routing/deploy.sh
fi
# Prove the browser suite has no dependency on inherited standalone outproxies.
for party in pusher puller oci-provider; do
  kubectl -n "$party-ns" scale deployment "$party-outproxy" --replicas=0
  kubectl -n "$party-ns" rollout status deployment "$party-outproxy" --timeout=60s
done
bash testing/shared/load-image.sh "$IMAGE_PREFIX/browser-test-client:$IMAGE_TAG"
# Echo and index belong to one fixture party and share its account/meter.
# Reuse production gateway auth, account routes, and deduction logging.
kubectl -n index-ns get configmap index-envoy-config -o json | python3 -c 'import json,sys; x=json.load(sys.stdin); x["metadata"]={"name":"echo-envoy-config","namespace":"index-ns"}; x["data"]["envoy.yaml"]=x["data"]["envoy.yaml"].replace("address: index-index,", "address: echo-server,"); print(json.dumps(x))' | kubectl apply -f -
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/browser/workloads.yaml | kubectl apply -f -
kubectl -n index-ns rollout status deployment/echo-server --timeout=180s
kubectl -n index-ns rollout status deployment/echo-envoy --timeout=180s
