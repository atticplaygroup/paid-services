#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
bash testing/oci/deploy.sh
for image in "$IMAGE_PREFIX/routing-test-client:$IMAGE_TAG" mysql:8.4; do
  bash testing/shared/load-image.sh "$image"
done
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT
kubectl apply -f testing/routing/workloads.yaml
helm dependency build charts/index
scoring_config=$(python3 -c 'import json; print(json.dumps([{"implementation":"ingress-time","functionality":json.load(open("testing/routing/scoring.json"))}]))')
helm upgrade --install index charts/index -n index-ns -f testing/routing/index-values.yaml \
  --set "indexImage.repository=$IMAGE_PREFIX/infrastructure,indexImage.tag=$IMAGE_TAG" \
  --set-json "env.enabledScorers=$scoring_config" \
  --set "mysqlHttp.image.repository=$IMAGE_PREFIX/infrastructure,mysqlHttp.image.tag=$IMAGE_TAG" \
  --set "meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$IMAGE_TAG" --wait --timeout 5m
for side in low high; do kubectl -n "dead-$side-ns" rollout status deployment --timeout=120s; done
# Copy only fixture keys; the seed runs inside the OCI party and uses gateway
# URLs for all calls to the storage and index parties.
kubectl -n puller-ns get secret e2e-dpop-keys -o json | python3 -c 'import json,sys; x=json.load(sys.stdin); x["metadata"]={"name":"e2e-dpop-keys","namespace":"oci-provider-ns"}; print(json.dumps(x))' | kubectl apply -f -
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/routing/seed-job.yaml | kubectl create -f -
bash testing/routing/wait-job.sh oci-provider-ns seed-routing
kubectl -n oci-provider-ns logs job/seed-routing | python3 -c 'import sys,base64; line=next(l for l in sys.stdin if l.startswith("ROUTING_FIXTURE=")); sys.stdout.buffer.write(base64.b64decode(line.split("=",1)[1]))' > "$fixture_dir/fixture.json"
kubectl -n puller-ns create configmap routing-fixture --from-file="$fixture_dir/fixture.json"

# Configure gateway prices through each party's production meter-chart hook.
# Redis access stays inside that party; test clients only call Envoy gateways.
for party in index oci-provider storage-provider; do
  chart=$party
  if [[ $party == oci-provider ]]; then chart=oci; fi
  if [[ $party == storage-provider ]]; then chart=kvstore; fi
  helm get values "$party" -n "$party-ns" -o json | python3 testing/routing/gateway-prices.py "$fixture_dir/fixture.json" "$party" > "$fixture_dir/$party-prices.json"
  helm upgrade "$party" "charts/$chart" -n "$party-ns" --reuse-values -f "$fixture_dir/$party-prices.json" --wait --timeout 2m
done
