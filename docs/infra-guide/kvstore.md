# Key Value Store

The `kvstore` workload is a meter for key-value storage abstraction. It manages storage cost and access cost. It can be used for cache, no-sql databased and blob storage.

## Metering

<!-- Model: for horizontally scaled on-demand storage, with unit cost foreseeable in the following period of time. -->

<!-- Goal: 
  - Autonomous: With dynamic unit price control, the metering service will never run out of money, where cost > profit
  - Fairness: The more you pay, the more you get.
-->

<!-- Write metering based on storage bytes and duration, ingress bytes etc. -->

<!-- Read metering based on access request count, egress bytes etc. -->

<!-- Unit price controlling -->

## Access control

<!-- AUTHORIZATION_MODE -->

<!-- CAS and value anchor -->

## Direct S3 reads

`s3.directAccess.enabled` defaults to `true`. Clients can use the native S3
API through the provider's existing Envoy endpoint. Only the configured bucket's
`/<bucket>` and `/<bucket>/...` paths are routed to S3. The account and kvstore
RPC routes continue to work on the same endpoint. Set the option to `false` to
remove the S3 routes and Envoy's dependency on read-only credentials.

For chart-managed embedded SeaweedFS, the chart generates a separate
bucket-scoped read/list identity and a `<release>-s3-readonly` Secret. Credentials
are retained on Helm upgrades. Kvstore keeps its write identity; Envoy receives
only the read-only credentials. Existing objects are not inspected or migrated,
and temporary object keys can appear in direct reads and listings.

For external S3, provision an identity with `s3:GetObject` and `s3:ListBucket`
permissions on the configured bucket and supply a Kubernetes Secret with
`accessKey` and `secretKey` keys through `s3.directAccess.existingSecret`. Its
default name is `<s3.existingSecret or release-s3>-readonly`. Configure
`s3.directAccess.region` (default `us-east-1`) for the backend's signing region.
`s3.endpoint` is a hostname with an optional port; `s3.secure` selects TLS and
defaults to `true`. Envoy verifies upstream TLS against its system CA bundle.
When supplying embedded SeaweedFS's `s3.existingSecret`, its `s3.json` must also
contain the read-only identity matching the separately supplied credentials.

Clients send requests through their outproxy with S3 client signing disabled.
Outproxy injects PAID authorization; Envoy verifies it before replacing it with
an AWS SigV4 signature using the read-only credentials. The client needs a funded
account at the storage provider and never needs the backend S3 credentials.

```bash
HTTPS_PROXY=http://127.0.0.1:9090 AWS_CA_BUNDLE=/path/to/outproxy-ca.crt \
  aws --no-sign-request --region us-east-1 \
  --endpoint-url https://storage.example \
  s3 cp s3://applications/user/public/value/CONTENT_CID ./object
```

Gateway usage is charged for duration, ingress bytes, and egress bytes. All direct
S3 paths use the Redis price hash `p:s3`, seeded through `meter.priceSeed.entries`
with `METER_TYPE_DURATION_MS`, `METER_TYPE_INGRESS_BYTES`, and
`METER_TYPE_EGRESS_BYTES`. Envoy supplies this service identifier from route
metadata, so callers cannot select their price schedule with a request header.

## OCI usage

<!-- Usage with OCI and ORAS -->
