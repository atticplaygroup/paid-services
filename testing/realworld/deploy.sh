#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
: "${CLUSTER_NAME:?}" "${KUBECONFIG:?}"
if [[ ${1:-} != --reuse-routing ]]; then bash testing/routing/deploy.sh; else bash testing/realworld/restore-payments.sh; fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for image in "$IMAGE_PREFIX/realworld:$IMAGE_TAG" "$IMAGE_PREFIX/mysql-tools:$IMAGE_TAG" "$IMAGE_PREFIX/infrastructure:$IMAGE_TAG" envoyproxy/envoy:v1.38.3; do
  bash testing/shared/load-image.sh "$image"
done
# Keep each database and its OCI conversion/outproxy within its fixture party.
kubectl -n puller-ns get secret e2e-dpop-keys -o json | python3 -c 'import json,sys; x=json.load(sys.stdin); x["metadata"]={"name":"e2e-dpop-keys","namespace":"pusher-ns"}; print(json.dumps(x))' | kubectl apply -f -
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/realworld/workloads.yaml | kubectl apply -f -
# Seed signed definitions and advertisements and obtain the intended principal.
kubectl -n puller-ns delete job seed-realworld --ignore-not-found
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$IMAGE_TAG/g" testing/realworld/seed-job.yaml | kubectl create -f -
bash testing/routing/wait-job.sh puller-ns seed-realworld
kubectl -n puller-ns logs job/seed-realworld | python3 -c 'import sys,base64; line=next(l for l in sys.stdin if l.startswith("REALWORLD_FIXTURE=")); sys.stdout.buffer.write(base64.b64decode(line.split("=",1)[1]))' > "$work/fixture.json"
kubectl -n puller-ns create configmap realworld-fixture --from-file="$work/fixture.json" --dry-run=client -o yaml | kubectl apply -f -
owner=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["proposerPrincipal"])' "$work/fixture.json")
helm upgrade --install realworld-proposer charts/mysql-proposer -n pusher-ns --reset-values \
  --set namespace=pusher-ns --set "image.repository=$IMAGE_PREFIX/mysql-tools,image.tag=$IMAGE_TAG" \
  --set mysql.database=realworld --set 'mysql.exportedSchemas[0]=realworld' \
  --set packer.ociAddress=pusher-oci.pusher-ns.svc.cluster.local:3000 \
  --set "packer.localOciUserID=$owner" \
  --set-string 'packer.readyQuery=SELECT COUNT(*) FROM realworld.users' \
  --set "packer.baselineRepo=$owner/realworld-baseline,packer.deltaRepo=$owner/realworld-delta,packer.manifestRepo=$owner/realworld-manifests,packer.application=realworld,owner=$owner" \
  --set-string 'packer.deltaSchedule=* * * * *'
kubectl -n pusher-ns rollout status statefulset/mysql-proposer --timeout=300s
kubectl -n pusher-ns rollout status deployment/realworld-proposer --timeout=180s
kubectl -n pusher-ns rollout status deployment/realworld-idp --timeout=180s
# Bootstrap after the publisher has checked schema readiness and cleaned its work directory.
# Subsequent deltas use the normal publisher scheduler, once a minute here.
kubectl -n pusher-ns exec mysql-proposer-0 -c publisher -- bash -euc '
  deadline=$((SECONDS + 120))
  until [[ $(< /proc/1/comm) == supercronic ]]; do
    if (( SECONDS >= deadline )); then echo "Timed out waiting for the MySQL publisher scheduler" >&2; exit 1; fi
    sleep 2
  done
  PUBLISH_MODE=baseline /usr/local/bin/publish.sh
'
helm dependency build charts/mysql-replica
helm upgrade --install realworld-replica charts/mysql-replica -n puller-ns -f testing/realworld/replica-values.yaml \
  --set "image.repository=$IMAGE_PREFIX/mysql-tools,image.tag=$IMAGE_TAG,mysqlHttp.image.repository=$IMAGE_PREFIX/infrastructure,mysqlHttp.image.tag=$IMAGE_TAG,meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$IMAGE_TAG" \
  --set importer.ociAddress=oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080 \
  --set "importer.manifestRepo=$owner/realworld-manifests,importer.applicationOwner=$owner"
kubectl -n puller-ns rollout status statefulset/mysql-replica --timeout=300s
# Combine the production sync/import jobs into one fixture loop; retain their
# artifact queue, integrity checks, GTIDs, and actual baseline/binlog import.
# Read stdin in a separate script file so the CronJob JSON remains available.
cat > "$work/follower.py" <<'PY'
import json,sys
jobs=json.load(sys.stdin)['items']
containers=[j['spec']['jobTemplate']['spec']['template']['spec']['containers'][0] for j in jobs]
spec=jobs[0]['spec']['jobTemplate']['spec']['template']['spec']
c=containers[0]
env={e['name']:e for container in containers for e in container.get('env',[])}
env['HTTP_PROXY']={'name':'HTTP_PROXY','value':'http://puller-outproxy.puller-ns.svc.cluster.local:9090'}
c['env']=list(env.values())
c['command']=['bash','-uc','while true; do /usr/local/bin/sync.sh && IMPORT_MODE=follow /usr/local/bin/import.sh; sleep 3; done']
spec['restartPolicy']='Always'
print(json.dumps({'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'realworld-follower','namespace':'puller-ns'},'spec':{'selector':{'matchLabels':{'app':'realworld-follower'}},'template':{'metadata':{'labels':{'app':'realworld-follower'}},'spec':spec}}}))
PY
kubectl -n puller-ns get cronjob mysql-replica-sync mysql-replica-importer -o json | python3 "$work/follower.py" > "$work/follower.json"
kubectl apply -f "$work/follower.json"
kubectl -n puller-ns rollout status deployment/realworld-replica-mysql-http --timeout=180s
kubectl -n puller-ns rollout status deployment/realworld-replica-envoy --timeout=180s
