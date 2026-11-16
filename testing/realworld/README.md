# RealWorld library E2E

This fixture exercises the proposer mutation application and browser read
application against the real PAID index, KvStore, OCI and MySQL replica
components. Phase 1 funds test identities through CreditBalance. The separate
Phase 2 test below funds a fresh browser wallet through the real devnet exchange.
Seeding and each test run give the publisher a larger fixture
allowance to cover retention charges for manifests and tag anchors; reader
identities receive a smaller allowance. The OCI conversion provider receives its
own downstream storage allowance, separate from the replica caller's credit at
the OCI gateway. Each run refreshes those fixture allowances and still checks
actual deductions.

Prerequisites: Docker, kind, kubectl, Helm 3, Node 22, Bun 1.4.2, Python 3,
OpenSSL, and enough capacity for the OCI/routing fixtures and two MySQL servers.
Use a dedicated cluster so teardown removes only this fixture.

```bash
export CLUSTER_NAME=realworld
export KUBECONFIG=/tmp/realworld.kubeconfig
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.34.0
bash testing/realworld/build.sh
bash testing/realworld/deploy.sh
bash testing/realworld/test.sh
```

CI runs these same build, deploy and test scripts in
`.github/workflows/e2e-realworld.yaml`. `deploy.sh --reuse-routing` can reuse an
already deployed routing fixture in the selected cluster. The harness explicitly publishes the initial baseline after schema setup.
The normal publisher scheduler publishes deltas once a minute in this fixture;
the weekly baseline schedule remains unchanged. Production defaults remain weekly
baselines and five-minute deltas. The importer runs short asynchronous cycles;
both use the production baseline and binlog scripts. They do not copy application rows or
query the primary to implement browser reads. Primary publication goes through
the proposer's local OCI converter to metered KvStore. Replication reads signed
publications through the OCI provider's metered gateway and client outproxy.
Browser SQL and object reads pass through their metered gateways directly.

## Interactive walkthrough

Install the workspace libraries, then launch after deployment:

```bash
bun install --cwd examples/realworld
bun install --cwd applications/router
bun install --cwd applications/client-auth
bun install --cwd applications/oci
bun install --cwd testing
bun install --cwd testing/realworld
bash testing/realworld/launch.sh
```

Open `http://localhost:3001`. The launcher port-forwards the index, storage,
replica, proposer and fixture IdP, registers signed localhost advertisements,
and provisions a separate fixture-funded browser key at runtime. It does not
embed the proposer's private signing key in the frontend. Run the interactive
launcher separately from E2E tests because it updates fixture advertisements to
use localhost endpoints. Stop it with Ctrl-C, then run
`bash testing/realworld/deploy.sh --reuse-routing` before rerunning E2E tests;
redeployment restores the cluster-internal advertisements.

1. Browse the global feed without an OIDC account. PAID credit still pays for
   guest reads.
2. Choose **Log in / Register** and register an email, password, and username
   with the fixture IdP. The exact callback is
   `http://localhost:3001/callback`; login uses authorization code and PKCE.
3. Edit the profile under **Settings**, optionally uploading an avatar. Email
   and credentials stay in the IdP, outside the published schema.
4. Create an article with tags and an optional image. The UI waits for the
   asynchronous publication and replica import before showing the article.
5. Favorite it, add/edit/delete content, or follow another author and inspect
   **Your feed**. Image bytes are fetched with PAID authentication, verified
   against their CID, and displayed through Blob URLs.

Published definitions include the versioned schema and separate read/mutation
functionalities. The fixture ConfigMap contains their identities, the intended
proposer principal, trusted indices and scoring configuration. Mutation business
logic verifies proposer-signed advertisements before sending OIDC tokens.
Provider reads receive request-bound PAID proofs; mutations do not.

## Coverage and diagnosis

The unmodified Conduit Postman collection runs under Newman against a test HTTP
adapter that invokes the same client read implementation used by the browser.
The adapter waits for replication between mutations and dependent assertions.
The collection is vendored from
`RenatoPassos/realworld-api-action` commit
`8d19e24238f30009ed6b76c9650cb9b795090bb4`, file
`postman-collection.json`, retaining its Thinkster MIT license in
`COLLECTION-LICENSE`. It includes 32 API requests; additional tests cover
filtered pagination and stable ordering, ownership rejection, validation, proposer signature checks, read-only SQL POST
failover, CORS, authentication, and metering. Playwright exercises actual UI
reads and mutations, OIDC registration/login, avatar/article image loading,
follows, feed, favorites, comments and article updates/deletion with ordinary
browser security enabled.

```bash
bash testing/realworld/diagnostics.sh
kubectl -n puller-ns logs job/e2e-realworld
```

The test container writes its Newman report, screenshot and Playwright trace to
`/tmp/realworld-artifacts`. Object retention remains market-driven: references
can outlive storage if nobody renews or revives the objects.

### Browser payments

After the Phase 1 test, run the exchange-funded SQL test on a Linux host:

```sh
bash testing/realworld/deploy-payments.sh
bash testing/realworld/test-payments.sh
```

Use the same `KUBECONFIG`, `IMAGE_PREFIX`, and `IMAGE_TAG` as the main deployment.
The payment deployment creates the dedicated `realworld-payments` namespace,
runs the exchange database migration, and configures the replica, index, and
object provider to accept its signed devnet tokens with fixture credit disabled.
It saves the original Helm values in a Kubernetes Secret for restoration. Rerun `deploy.sh --reuse-routing`
to restore Phase 1 funding settings before rerunning that test.

The Playwright payment test generates a new wallet inside Chromium, verifies its
initial chain balance is zero, requests real Sui devnet faucet funds, transfers
to the exchange, buys points, redeems the resulting token at the replica, and
executes paid SQL through the browser cashier authentication adapter. It also
uses authenticated index discovery for routed article reads and object
upload/download, verifies that the retrieved image decodes, and opens the real
frontend as a guest using the browser wallet without a fixture client key.
The SQL account balance must decrease after the read. It never
calls `CreditBalance`. It requires public Sui devnet and faucet availability.
The test frontend relays only validated devnet faucet requests because the public
faucet does not allow browser CORS; all signing and wallet operations run in the
browser. Browser security remains enabled.

For local development, `REALWORLD_DEVNET_FAUCET=true` enables the same fixed
`POST /v2/gas` relay in `frontend-server.ts`. Configure the browser payment's
`suiFaucetUrl` to the frontend origin. The relay is disabled by default.

The payment fixture uses nonzero demo prices of `0.01` per configured meter unit,
following the existing quickstart price scale. The fresh wallet deposits two SUI
into the exchange and purchases up to 500 million balance units per provider.
Mutation authentication continues to use OIDC through plain fetch; the Phase 1
suite covers the full login and write flows.

The API and frontend workflow has a 35-minute overall test allowance, and each
replication assertion retains its bounded polling deadline. Reused local
fixtures can accumulate more binlog and OCI history than a clean CI deployment;
the standard collection alone can take about 16 minutes there. The Kubernetes
job and launcher allow 40 minutes for both application tests.
