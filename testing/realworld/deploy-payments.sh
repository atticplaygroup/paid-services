#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
: "${KUBECONFIG:?}"
helm dependency build charts/exchange
kubectl apply -f testing/realworld/payment-exchange.yaml
kubectl -n realworld-payments rollout status deployment/realworld-postgres --timeout=180s
kubectl -n realworld-payments delete job realworld-exchange-migrate --ignore-not-found
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/realworld/payment-migrate.yaml | kubectl apply -f -
kubectl -n realworld-payments wait --for=condition=complete job/realworld-exchange-migrate --timeout=120s
helm upgrade --install realworld-exchange charts/exchange -n realworld-payments \
  -f testing/realworld/payment-exchange-values.yaml \
  --set "image.repository=$IMAGE_PREFIX/infrastructure,image.tag=$IMAGE_TAG,meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$IMAGE_TAG" \
  --timeout 5m
kubectl -n realworld-payments rollout status deployment --timeout=300s
# Enable exchange-funded SQL reads after the Phase 1 fixture test has finished.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if ! kubectl -n realworld-payments get secret realworld-phase1-values >/dev/null 2>&1; then
  helm get values realworld-replica -n puller-ns -o json > "$work/realworld-replica.json"
  helm get values index -n index-ns -o json > "$work/index.json"
  helm get values storage-provider -n storage-provider-ns -o json > "$work/storage-provider.json"
  kubectl -n realworld-payments create secret generic realworld-phase1-values \
    --from-file="$work/realworld-replica.json" --from-file="$work/index.json" --from-file="$work/storage-provider.json"
fi
node testing/quickstart/chart/files/prepare-values.mjs \
  http://realworld-exchange-envoy.realworld-payments.svc.cluster.local:8080 > "$work/provider.json"
python3 - "$work/provider.json" "$work/replica.json" <<'PY'
import json,sys
values=json.load(open(sys.argv[1]))['provider']
values['env']['accountDomains']=['account.realworld-replica-envoy.puller-ns.svc.cluster.local']
values['meter']['account'].update({
 'faucetMode':False,'validCoinEnvironment':2,
 'trustedIssuers':[{'issuer':'https://exchange.realworld.test','jwksUrl':'http://realworld-exchange-envoy.realworld-payments.svc.cluster.local:8080/.well-known/jwks.json'}]})
values['meter']['authz']={'allowZeroBalanceHTUs':['/account.v1.AccountService/GetBalance','/account.v1.AccountService/DepositOrCreateAccount']}
values['cors']={'allowOrigins':['http://localhost:3001','http://127.0.0.1:3001']}
json.dump(values,open(sys.argv[2],'w'))
PY
helm get values realworld-replica -n puller-ns -o json | python3 testing/realworld/payment-prices.py > "$work/replica-prices.json"
helm upgrade realworld-replica charts/mysql-replica -n puller-ns --reuse-values -f "$work/replica.json" -f "$work/replica-prices.json"
kubectl -n puller-ns rollout status deployment/realworld-replica-envoy --timeout=120s
kubectl -n puller-ns rollout status deployment/realworld-meter-account --timeout=120s

for party in index storage-provider; do
  chart=index
  if [[ $party == storage-provider ]]; then chart=kvstore; fi
  helm get values "$party" -n "$party-ns" -o json | python3 testing/realworld/payment-prices.py > "$work/$party-prices.json"
  helm upgrade "$party" "charts/$chart" -n "$party-ns" --reuse-values -f "$work/replica.json" -f "$work/$party-prices.json"
  kubectl -n "$party-ns" rollout status deployment/"$party-envoy" --timeout=120s
done
