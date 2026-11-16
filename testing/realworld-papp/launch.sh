#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${KUBECONFIG:?Set KUBECONFIG to the deployed RealWorld fixture cluster}"
# A kind cluster alone is insufficient: the demo needs the deployed SQL replica,
# Next.js backend, OIDC provider, routing services, and signed fixture config.
if ! kubectl -n puller-ns get configmap realworld-papp-fixture >/dev/null 2>&1; then
  cat >&2 <<'HELP'
The RealWorld pApp fixture is missing from the selected cluster,
or the cluster cannot be accessed. Check KUBECONFIG and deploy the fixture first:

  export CLUSTER_NAME=<your-kind-cluster>
  bash testing/realworld-papp/build.sh
  bash testing/realworld-papp/deploy.sh
  bash testing/realworld-papp/launch.sh

Use the pApp image local/realworld-papp:dev. The library example image
local/realworld:dev does not contain this demo's dependencies.
HELP
  exit 1
fi
work=$(mktemp -d)
pod=realworld-papp-demo
papp_demo_forward_pid=''
papp_demo_created=false
cleanup() {
  if [[ -n $papp_demo_forward_pid ]]; then kill "$papp_demo_forward_pid" 2>/dev/null || true; fi
  if [[ $papp_demo_created == true ]]; then kubectl -n puller-ns delete pod "$pod" --ignore-not-found --wait=false >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
image=${PAPP_DEMO_IMAGE:-$(kubectl -n puller-ns get job e2e-realworld-papp -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)}
image=${image:-local/realworld-papp:dev}
case ${image##*/} in
  realworld|realworld:*|realworld@*)
    echo "Image '$image' is for the library example. Use PAPP_DEMO_IMAGE=local/realworld-papp:dev for this pApp demo." >&2
    exit 1
    ;;
esac
python3 - "$image" "$pod" <<'PY' > "$work/pod.json"
import json,sys
print(json.dumps({"apiVersion":"v1","kind":"Pod","metadata":{"name":sys.argv[2],"namespace":"puller-ns"},"spec":{
  "restartPolicy":"Never","containers":[{"name":"demo","image":sys.argv[1],"imagePullPolicy":"IfNotPresent",
    "command":["bash","-euc","while [[ ! -f /tmp/papp-demo-start ]]; do sleep 1; done; if [[ -f /tmp/papp-demo-tls/cert.pem ]]; then export PAPP_DEMO_TLS_DIR=/tmp/papp-demo-tls; fi; exec bun testing/realworld-papp/demo.ts"],
    "volumeMounts":[{"name":"keys","mountPath":"/etc/dpop-keys","readOnly":True},{"name":"fixture","mountPath":"/etc/realworld-papp","readOnly":True}]}],
  "volumes":[{"name":"keys","secret":{"secretName":"e2e-dpop-keys"}},{"name":"fixture","configMap":{"name":"realworld-papp-fixture"}}]}}))
PY
kubectl create -f "$work/pod.json"
papp_demo_created=true
kubectl -n puller-ns wait --for=condition=Ready "pod/$pod" --timeout=120s
# Reuse installed image dependencies, with the current checkout's source.
tar --exclude=node_modules --exclude=.next --exclude=dist --exclude='*.lock' -cf "$work/source.tar" \
  applications/ipfs/src applications/papp-sdk/src applications/papp-gateway/src \
  applications/user-server/src applications/cashier/src applications/router/src applications/client-auth/src \
  examples/realworld-papp/frontend examples/realworld-papp/baseapp testing/realworld-papp testing/papp testing/shared proposer/app-packer
kubectl -n puller-ns exec -i "$pod" -- tar -xf - -C /app < "$work/source.tar"
if [[ -n ${PAPP_DEMO_TLS_DIR:-} ]]; then
  kubectl -n puller-ns exec "$pod" -- mkdir -m 700 /tmp/papp-demo-tls
  tar -cf "$work/tls.tar" -C "$PAPP_DEMO_TLS_DIR" cert.pem key.pem
  kubectl -n puller-ns exec -i "$pod" -- tar -xf - -C /tmp/papp-demo-tls < "$work/tls.tar"
  if [[ -f $PAPP_DEMO_TLS_DIR/ca.pem ]]; then
    kubectl -n puller-ns exec -i "$pod" -- sh -c 'cat > /tmp/papp-demo-tls/ca.pem' < "$PAPP_DEMO_TLS_DIR/ca.pem"
  fi
fi
# Generate schemas/types and build the overlaid React source before publishing.
kubectl -n puller-ns exec "$pod" -- bash -euc 'cd /app/examples/realworld-papp/frontend; bun run build'
kubectl -n puller-ns exec "$pod" -- touch /tmp/papp-demo-start
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if kubectl -n puller-ns exec "$pod" -- cat /tmp/papp-demo.json > "$work/demo.json" 2>/dev/null; then ready=true; break; fi
  sleep 1
done
if [[ $ready != true ]]; then kubectl -n puller-ns logs "$pod"; exit 1; fi
# Export only the current public CA. Fingerprinted names distinguish restarts
# from older fixture CAs with the same subject; private keys stay in the pod.
python3 - "$work/demo.json" "$pod" <<'PY'
import hashlib,json,os,pathlib,ssl,subprocess,sys
metadata=pathlib.Path(sys.argv[1])
d=json.loads(metadata.read_text())
if d.get('ca'):
  pem=subprocess.check_output(['kubectl','-n','puller-ns','exec',sys.argv[2],'--','cat',d['ca']])
  fingerprint=hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.decode())).hexdigest()
  directory=pathlib.Path(os.environ.get('XDG_CACHE_HOME',str(pathlib.Path.home()/'.cache')))/'realworld-papp-demo'
  directory.mkdir(parents=True,exist_ok=True)
  path=directory/f'ca-{fingerprint[:16]}.pem'
  path.write_bytes(pem)
  d.update(caFile=str(path),caFingerprint=fingerprint)
  metadata.write_text(json.dumps(d))
PY
kubectl -n puller-ns port-forward --address 127.0.0.1 "pod/$pod" 3002:3002 3003:3003 3004:3004 4000:4000 > "$work/forward.log" 2>&1 &
papp_demo_forward_pid=$!
python3 - "$work/demo.json" <<'PY'
import json,socket,sys,time
for port in [3002,3003,3004,4000]:
  deadline=time.monotonic()+15
  while True:
    try:
      with socket.create_connection(('127.0.0.1',port),timeout=1):break
    except OSError:
      if time.monotonic()>deadline:raise
      time.sleep(.1)
d=json.load(open(sys.argv[1]))
print('\nOpen the pApp in a separate Chrome/Chromium profile with the fixture certificate trusted:')
print(f'chromium --user-data-dir=/tmp/paid-papp-browser --ignore-certificate-errors-spki-list={d["spki"]} "{d["url"]}"')
if d.get('caFile'):
  print(f'\nFirefox CA for this run: {d["caFile"]}')
  print(f'CA SHA-256: {d["caFingerprint"]}')
  print('In Firefox Settings > Privacy & Security > Certificates > View Certificates > Authorities,')
  print('remove any older "PAID fixture CA", then import this CA and trust it to identify websites.')
  print('The default CA changes on every launch; import the file printed for the current run.')
else:
  print('\nFirefox: trust the CA that issued your custom TLS certificate. Include ca.pem in PAPP_DEMO_TLS_DIR to export it here.')
print(f'\npApp:       {d["url"]}')
print('User server: https://localhost:3002')
print('\nOn first access, enter https://localhost:3002 on the PAID configuration page.')
print('Keep this terminal open. Ctrl-C stops the demo and removes its pod.')
PY
wait "$papp_demo_forward_pid"
