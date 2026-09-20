#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Feature 4 E2E Setup ==="

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

# Build and load Feature 4 tools image
docker build -t paid-feature4-mysql:dev -f "$ROOT/charts/mysql-proposer/Dockerfile.mysql-tools" "$ROOT/charts/mysql-proposer"
kind load docker-image paid-feature4-mysql:dev --name paid-services

# Deploy proposer and replica
helm upgrade --install proposer "$ROOT/charts/mysql-proposer" \
  --namespace proposer-ns --create-namespace \
  --set packer.ociAddress=registry.registry-system.svc.cluster.local:5000 \
  --set owner=test-proposer

helm upgrade --install replica "$ROOT/charts/mysql-replica" \
  --namespace replica-ns --create-namespace \
  --set importer.ociAddress=registry.registry-system.svc.cluster.local:5000 \
  --set importer.baselineRepo=baseline_app \
  --set importer.baselineTag=latest

# Wait for pods
kubectl wait --for=condition=ready --timeout=180s pod/mysql-proposer-0 -n proposer-ns
kubectl wait --for=condition=ready --timeout=180s pod/mysql-replica-0 -n replica-ns
kubectl wait --for=condition=available --timeout=120s deployment/registry -n registry-system

echo "=== Feature 4 E2E Setup Complete ==="
