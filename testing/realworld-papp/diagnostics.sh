#!/usr/bin/env bash
set -uo pipefail
for namespace in pusher-ns puller-ns index-ns storage-provider-ns oci-provider-ns; do
  kubectl -n "$namespace" get pods -o wide
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp | tail -25
 done
kubectl -n pusher-ns logs statefulset/mysql-proposer -c publisher --tail=80
kubectl -n pusher-ns logs deployment/realworld-baseapp --tail=80
kubectl -n pusher-ns logs deployment/realworld-idp --tail=40
kubectl -n puller-ns logs deployment/realworld-follower --tail=80
kubectl -n puller-ns logs job/e2e-realworld-papp --tail=100
