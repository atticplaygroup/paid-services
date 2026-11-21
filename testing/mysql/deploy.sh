#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/testing/shared/image-env.sh"

echo "=== MySQL replication E2E Setup ==="

# Deploy in-cluster OCI registry (for testing, not PAID metered)
kubectl create namespace registry-system --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -n registry-system -f - <<APPLY
apiVersion: apps/v1
kind: Deployment
metadata:
  name: registry
spec:
  replicas: 1
  selector:
    matchLabels: { app: registry }
  template:
    metadata:
      labels: { app: registry }
    spec:
      containers:
        - name: registry
          image: registry:2
          ports:
            - { containerPort: 5000 }
---
apiVersion: v1
kind: Service
metadata:
  name: registry
  namespace: registry-system
spec:
  selector: { app: registry }
  ports:
    - { port: 5000, targetPort: 5000 }
APPLY

# Export only the node platform, as in the other kind fixtures.
: "${CLUSTER_NAME:?Set CLUSTER_NAME to the existing kind cluster}"
: "${KUBECONFIG:?Set KUBECONFIG to the cluster kubeconfig}"
for image in "$IMAGE_PREFIX/infrastructure:$IMAGE_TAG" envoyproxy/envoy:v1.38.3 valkey/valkey:8-alpine "$IMAGE_PREFIX/mysql-tools:$IMAGE_TAG" "$IMAGE_PREFIX/mysql-test-client:$IMAGE_TAG" registry:2; do
  bash "$ROOT/testing/shared/load-image.sh" "$image"
done

# Deploy proposer and replica
helm upgrade --install proposer "$ROOT/charts/mysql-proposer" \
  --namespace proposer-ns --create-namespace \
  --set-string "image.repository=$IMAGE_PREFIX/mysql-tools,image.tag=$IMAGE_TAG" \
  --set packer.ociAddress=registry.registry-system.svc.cluster.local:5000 \
  --set 'mysql.exportedSchemas[0]=user_profile,mysql.exportedSchemas[1]=public_catalog' \
  --set owner=test-proposer --set packer.suspend=true --set packer.deltaSuspend=true

kubectl create namespace replica-ns --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$ROOT/testing/mysql/redis.yaml"
helm dependency build "$ROOT/charts/mysql-replica"
helm upgrade --install replica "$ROOT/charts/mysql-replica" \
  --namespace replica-ns --create-namespace -f "$ROOT/testing/mysql/sql-values.yaml" \
  --set-string "mysqlHttp.image.repository=$IMAGE_PREFIX/infrastructure,mysqlHttp.image.tag=$IMAGE_TAG,meter.image.repository=$IMAGE_PREFIX/infrastructure,meter.image.tag=$IMAGE_TAG" \
  --set-string "image.repository=$IMAGE_PREFIX/mysql-tools,image.tag=$IMAGE_TAG" \
  --set importer.ociAddress=registry.registry-system.svc.cluster.local:5000 \
  --set importer.manifestRepo=app-manifests \
  --set importer.applicationOwner=test-proposer --set importer.suspend=true

# Wait for pods
kubectl -n replica-ns rollout status statefulset/mysql-replica-s3 --timeout=300s
kubectl -n proposer-ns rollout status statefulset/mysql-proposer --timeout=300s
kubectl -n replica-ns rollout status statefulset/mysql-replica --timeout=300s
kubectl wait --for=condition=available --timeout=120s deployment/registry -n registry-system

echo "=== MySQL replication E2E Setup Complete ==="

kubectl -n replica-ns rollout status deployment/replica-mysql-http --timeout=300s
kubectl -n replica-ns rollout status deployment/replica-envoy --timeout=300s
