#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source testing/shared/image-env.sh
docker build -t "$IMAGE_PREFIX/infrastructure:$OCI_IMAGE_TAG" -f docker/infrastructure.Dockerfile .
docker build -t "$IMAGE_PREFIX/outproxy:$OCI_IMAGE_TAG" -f docker/outproxy.Dockerfile .
docker build -t "$IMAGE_PREFIX/oci:$OCI_IMAGE_TAG" -f docker/oci.Dockerfile .
docker pull chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d
docker build -t "$IMAGE_PREFIX/oci-test-client:$OCI_IMAGE_TAG" -f testing/oci/Dockerfile.client .
docker build -t "$IMAGE_PREFIX/s3-retention-rules:$OCI_IMAGE_TAG" -f docker/s3-retention-rules.Dockerfile .
