#!/usr/bin/env bash
# Create trust material before starting OCI integration workloads.
set -euo pipefail
OCI_CERT_DIR=$(mktemp -d)
trap 'rm -rf "$OCI_CERT_DIR"' EXIT
umask 077
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 1 \
  -keyout "$OCI_CERT_DIR/ca.key" -out "$OCI_CERT_DIR/ca.crt" -subj '/CN=oci-test-ca' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:1' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes -keyout "$OCI_CERT_DIR/tls.key" \
  -out "$OCI_CERT_DIR/tls.csr" -subj '/CN=oci-test-intermediate'
openssl x509 -req -sha256 -in "$OCI_CERT_DIR/tls.csr" -CA "$OCI_CERT_DIR/ca.crt" \
  -CAkey "$OCI_CERT_DIR/ca.key" -CAcreateserial -days 1 -out "$OCI_CERT_DIR/tls.crt" \
  -extfile <(printf '%s\n' 'basicConstraints=critical,CA:TRUE,pathlen:0' 'keyUsage=critical,keyCertSign,cRLSign')
openssl req -new -newkey rsa:3072 -nodes -keyout "$OCI_CERT_DIR/provider.key" \
  -out "$OCI_CERT_DIR/provider.csr" -subj '/CN=oci-test-provider'
openssl x509 -req -sha256 -in "$OCI_CERT_DIR/provider.csr" -CA "$OCI_CERT_DIR/ca.crt" \
  -CAkey "$OCI_CERT_DIR/ca.key" -CAcreateserial -days 1 -out "$OCI_CERT_DIR/provider.crt" \
  -extfile <(printf '%s\n' 'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' 'extendedKeyUsage=serverAuth' \
    'subjectAltName=DNS:storage-provider-envoy.storage-provider-ns.svc.cluster.local,DNS:oci-provider-envoy.oci-provider-ns.svc.cluster.local')
openssl verify -CAfile "$OCI_CERT_DIR/ca.crt" "$OCI_CERT_DIR/tls.crt" "$OCI_CERT_DIR/provider.crt"
for party in puller pusher oci-provider; do
  kubectl -n "$party-ns" create secret generic outproxy-tls \
    --from-file=ca.crt="$OCI_CERT_DIR/ca.crt" --from-file=tls.crt="$OCI_CERT_DIR/tls.crt" \
    --from-file=tls.key="$OCI_CERT_DIR/tls.key" --dry-run=client -o yaml | kubectl apply -f -
done
for party in storage-provider oci-provider; do
  kubectl -n "$party-ns" create secret generic provider-tls \
    --from-file=ca.crt="$OCI_CERT_DIR/ca.crt" --from-file=tls.crt="$OCI_CERT_DIR/provider.crt" \
    --from-file=tls.key="$OCI_CERT_DIR/provider.key" --dry-run=client -o yaml | kubectl apply -f -
done
