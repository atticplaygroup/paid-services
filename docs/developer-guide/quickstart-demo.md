# Prepare and test the quickstart demo

The [public quickstart](../quickstart.md) describes a client using one shared paying party (outproxy and cashier), a kvstore service provider, and the provider's chosen SUI devnet exchange. [quickstart-demo](../../testing/quickstart/chart/README.md) installs these parties and their own dependencies. It runs independently of the OCI integration suite, Flux, Gitea, and party-specific DNS rewrites.

## Deploy the local demo

You need Docker, kind, Helm, kubectl, ripgrep, jq, and Bash. From the repository root:

```bash
bash testing/quickstart/deploy.sh
export KUBECONFIG="$PWD/testing/quickstart/.kubeconfig"
```

The script creates or reuses `paid-quickstart`, builds application images, loads them into kind, installs the chart as `quickstart` in namespace `quickstart`, and verifies the seed upload plus HTTP and HTTPS downloads. All scripts, values, and chart definitions are in this repository; no sibling checkout, Flux, or Gitea is needed. Reuse already built images with `BUILD_IMAGES=false`. Override `CLUSTER_NAME` or `KUBECONFIG` if needed. Additional Helm arguments (`-f custom-values.yaml`) override the local defaults. The demo seed CronJob is suspended by the local test values; the script runs it once. Enable scheduled content renewal with `--set seed.suspend=false` when leaving the demo running.

The first seed obtains devnet funds through cashier if necessary, deposits SUI at the exchange, purchases provider points, redeems the receipt, uploads [welcome.txt](../../testing/quickstart/chart/files/welcome.txt), and verifies HTTP and HTTPS downloads byte for byte. Faucet mode is disabled on both the provider and exchange. Provider and exchange account balances start empty; no points or wallet balances are injected by the deployment script. Seeding requires reachable SUI devnet services and an available faucet or a pre-funded paying wallet.

The file contains `Welcome, PAID user!` followed by a newline. Its CIDv1 (raw codec, SHA-256) is:

```text
bafkreihfqce2w5fkfwct23alewvtt56pwg7yzeayg4tfhjme57ie44qbam
```

## Download as a reader

Cluster Service names resolve inside the cluster. Prepare a temporary client:

```bash
kubectl -n quickstart run quickstart-reader --image=alpine:3.22 --restart=Never --command -- sleep 3600
kubectl -n quickstart wait --for=condition=Ready pod/quickstart-reader --timeout=90s
kubectl -n quickstart exec quickstart-reader -- apk add --no-cache curl jq
kubectl -n quickstart get secret quickstart-proxy-tls -o jsonpath='{.data.ca\.crt}' | base64 -d | \
  kubectl -n quickstart exec -i quickstart-reader -- sh -c 'cat > /tmp/ca.crt'
```

Read over HTTPS through the shared proxy:

```bash
kubectl -n quickstart exec quickstart-reader -- curl \
  --proxy http://quickstart:8080 --cacert /tmp/ca.crt --fail-with-body -sS --noproxy '' \
  -H 'content-type: application/json' -H 'x-request-id: quickstart-read-https' \
  -d '{"key":"bafkreihfqce2w5fkfwct23alewvtt56pwg7yzeayg4tfhjme57ie44qbam"}' \
  https://quickstart-provider-envoy:8443/kvstore.v1.MeteredStorageService/GetCASValue \
  | jq -er .value | base64 -d
```

Expected output: `Welcome, PAID user!`. For plain HTTP, change the target to `http://quickstart-provider-envoy:8080`. The client needs no wallet, authorization header, or per-user ACL. Remove it with `kubectl -n quickstart delete pod quickstart-reader`.

## Refresh content or inspect funding

The chart installs `<release>-seed`, a six-hourly CronJob using [files/seed.ts](../../testing/quickstart/chart/files/seed.ts). It refreshes the one-year blob TTL and verifies both protocols. Start another seed/verification run with:

```bash
bash testing/quickstart/quickstart.sh
kubectl -n quickstart get cronjobs,jobs
kubectl -n quickstart logs deployment/quickstart -c cashier
```

Seed jobs retain logs, retry failures, and stop after fifteen minutes. Cashier requests faucet funds lazily when its wallet cannot cover a deposit and gas. Supply a funded wallet and set `proxy.cashier.autoFaucet: false` to disable automatic faucet requests. Use `seed.suspend: true` to suspend scheduled work. The local Redis and MinIO storage is ephemeral: after resetting it, rerun the seed. PostgreSQL retains exchange balances on its PVC; deleting the kind cluster removes all demo data.

## GitHub CI and local Gitea testing

[Quickstart kind](../../.github/workflows/quickstart.yaml) is a GitHub Actions workflow that runs on pushes, pull requests, and manual dispatch. Gitea also discovers it under `.github/workflows`, so the same workflow can be tested locally before publishing to GitHub. It uses checkout, Helm setup, and kind actions, builds this commit's four application images, and installs the chart in a fresh cluster. It configures a fresh paying wallet, asserts its SUI balance is zero before any authorization request, runs the seed using cashier’s lazy faucet funding, and then [the HTTPS reader command](../../testing/quickstart/quickstart-read.sh), comparing the decoded response byte for byte with `welcome.txt`. It also installs `outproxy-with-faucet` as a separate Helm release using the demo credentials and CA, and verifies a download through that independently deployed proxy. Failed jobs print Kubernetes diagnostics; the kind action removes the CI cluster afterward. Each run uses its own cluster name and kubeconfig, so the manual demo can stay running.

Optional local Gitea testing requires a Gitea instance and a runner registered for this repository with label `ubuntu-latest:host`. Run it on a Linux host with Bash, Git, Node.js, jq, and Docker (API 1.48 or newer for platform-specific image exports), with permission to use the Docker daemon. The actions install Helm, kind, and kubectl. The runner needs network access to GitHub, container registries, and SUI devnet/faucet endpoints. A devnet outage or faucet limit fails CI, just as it fails manual deployment.

For a Gitea instance using a private CA, configure `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, and `GIT_SSL_CAINFO` with your CA file. Set `RUNNER_TOOL_CACHE` and the runner's `host.workdir_parent` to writable directories on the runner host. Register using a repository registration token from Gitea's **Settings → Actions → Runners**:

```bash
gitea-runner -c config.yaml register \
  --instance "$GITEA_URL" --name quickstart-host --labels ubuntu-latest:host
gitea-runner -c config.yaml daemon
```

To run the CI deployment locally after building the four images, create a separate kind cluster and run:

```bash
export CLUSTER_NAME=quickstart-ci-local KUBECONFIG="$PWD/.quickstart-ci.kubeconfig"
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG"
bash testing/quickstart/quickstart-kind.sh
bash testing/quickstart/quickstart.sh
bash testing/quickstart/quickstart-read.sh
kind delete cluster --name "$CLUSTER_NAME"
rm "$KUBECONFIG"
```

## Host the public demo

Follow the chart's [custom-values instructions](../../testing/quickstart/chart/README.md#custom-values) for image references, identities, signed provider manifest, issuer/JWKS trust, cashier origins, and managed TLS Secrets. Proxy-party values are nested under `proxy`; it can also be installed separately using [outproxy-with-faucet](../../charts/outproxy-with-faucet/README.md). Keep payment coin/environment consistent across cashier, manifest, exchange, and provider (SUI devnet is `1`/`2`).

Expose proxy and provider at the public endpoints, configure DNS, and distribute the proxy's CA at `https://outproxy.paid-services.com/ca.crt` using publicly trusted HTTPS. That public certificate download endpoint is an operator responsibility. Replace the placeholder domain TODO in the reader guide only after verifying both public commands. The generated proxy CA is a demo trust anchor; trusting it enables TLS interception as explained in the quickstart.

The proxy can optionally accept client connections over TLS; see [TLS connections to the proxy](../../testing/quickstart/chart/README.md#tls-connections-to-the-proxy) for the separate endpoint Secret and a manual HTTPS-proxy reader check. The default local and CI tests continue to connect to the proxy over HTTP.
