#!/usr/bin/env bash
# Standalone OCI integration fixture for e2e-oci; no Flux or sibling checkout needed.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${CLUSTER_NAME:?Set CLUSTER_NAME to the existing kind cluster}"
: "${KUBECONFIG:?Set KUBECONFIG to the cluster kubeconfig}"
source testing/shared/image-env.sh
[[ $OCI_IMAGE_TAG =~ ^[a-zA-Z0-9_.-]+$ ]] || { echo 'Invalid OCI_IMAGE_TAG' >&2; exit 1; }
OCI_IMAGE_DIR=$(mktemp -d)
trap 'rm -rf "$OCI_IMAGE_DIR"' EXIT
OCI_NODE_PLATFORM="linux/$(docker version --format '{{.Server.Arch}}')"
for image in "$IMAGE_PREFIX/s3-retention-rules:$OCI_IMAGE_TAG" "$IMAGE_PREFIX/infrastructure:$OCI_IMAGE_TAG" "$IMAGE_PREFIX/outproxy:$OCI_IMAGE_TAG" "$IMAGE_PREFIX/oci:$OCI_IMAGE_TAG" chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d "$IMAGE_PREFIX/oci-test-client:$OCI_IMAGE_TAG" envoyproxy/envoy:v1.33.0 valkey/valkey:8-alpine; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"
  # Exclude unpulled platforms retained by Docker's containerd image store.
  docker save --platform "$OCI_NODE_PLATFORM" -o "$OCI_IMAGE_DIR/image.tar" "$image"
  kind load image-archive "$OCI_IMAGE_DIR/image.tar" --name "$CLUSTER_NAME"
done
kubectl apply -f testing/oci/namespaces.yaml
bash testing/oci/setup-tls.sh
kubectl apply -f testing/oci/coredns.yaml
kubectl -n kube-system rollout restart deployment/coredns
kubectl -n kube-system rollout status deployment/coredns --timeout=120s
sed -e "s|local/|$IMAGE_PREFIX/|g" -e "s/:dev/:$OCI_IMAGE_TAG/g" testing/oci/workloads.yaml | kubectl apply -f -
helm dependency build charts/kvstore
helm dependency build charts/oci
helm upgrade --install storage-provider charts/kvstore -n storage-provider-ns -f testing/oci/storage-provider-values.yaml \
  --set "image.repository=$IMAGE_PREFIX/infrastructure,image.tag=$OCI_IMAGE_TAG,meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$OCI_IMAGE_TAG,s3.retentionRules.image.repository=$IMAGE_PREFIX/s3-retention-rules,s3.retentionRules.image.tag=$OCI_IMAGE_TAG" --wait --timeout 5m
helm upgrade --install oci-provider charts/oci -n oci-provider-ns -f testing/oci/oci-provider-values.yaml \
  --set "meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$OCI_IMAGE_TAG,ociImage.repository=$IMAGE_PREFIX/oci,ociImage.tag=$OCI_IMAGE_TAG" --wait --timeout 5m
for namespace in storage-provider-ns oci-provider-ns pusher-ns puller-ns; do
  kubectl -n "$namespace" rollout status deployment --timeout=180s
done
bash testing/shared/reconcile-retention.sh storage-provider-ns storage-provider-s3-retention-rules
# Derive the test identities from each outproxy's actual direct-mode configuration.
OCI_KEY_DIR=$(mktemp -d "$OCI_IMAGE_DIR/keys.XXXXXX")
for party in pusher puller oci-provider; do
  kubectl -n "$party-ns" get deployment "$party-outproxy" -o json \
    | node testing/oci/dpop-key.cjs > "$OCI_KEY_DIR/$party.json"
done
kubectl -n puller-ns create secret generic e2e-dpop-keys --from-file="$OCI_KEY_DIR" \
  --dry-run=client -o yaml | kubectl apply -f -
