# Proposer tutorial - A PAID blog website

> [!WARNING] Agent generated docs
>
> This file is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

The RealWorld example separates the proposer mutation application from the
browser read application. The proposer accepts OIDC-authenticated writes and
publishes its public database. Infrastructure providers restore those
publications and serve paid reads, while the browser implements RealWorld read
operations using client-compiled SQL.

## Run it yourself

The [deployment and E2E guide](../../../../testing/realworld/README.md) provides
prerequisites and the exact build, deploy, test, launch and teardown commands.
Use a dedicated kind cluster. Build the images, deploy the PAID routing fixture
and RealWorld workloads, then run the Conduit API collection and Playwright
suite using `testing/realworld/test.sh`.

For an interactive session, run `testing/realworld/launch.sh` after deployment
and open `http://localhost:3001`. Browse as a guest, choose **Log in / Register**,
create a profile and an article, attach an image, and wait for its publication
to become readable. The fixture launcher provisions a separate browser payment
key and credit; it does not distribute the proposer's signing key to readers.

## Browser delivery and login

Serve the frontend from localhost HTTP for local development and HTTPS for a
public deployment. Browsers treat localhost as a secure context. Register the
exact callback URL with the OIDC provider; the fixture uses
`http://localhost:3001/callback`, authorization code, PKCE, state and nonce.
The fixture IdP holds credentials and email outside the published schema.

The echo example uses `file://`. File pages have an opaque origin in modern
browsers and are not a portable basis for OIDC callbacks, so RealWorld does not
require file-based login. The frontend serving origin is a browser integration
choice; the intended proposer principal remains the trust anchor for mutation
endpoint discovery.

## Define the functionality

The fixture publishes signed behavior and variant repositories under distinct
maintainers, verifies them, and registers advertisements with the index. The
browser config names the expected proposer principal, trusted indices,
provider scoring rule, and separate mutation, SQL-read and object
functionalities. See [routing](../../../client-guide/routing.md).

The SQL schema in `examples/realworld/schema.sql`, its types, and the mysql-http
request/response contract form part of the versioned read behavior. A breaking
schema change requires a new behavior version and compatible client logic.
The data variant identifies the proposer's public collection and its
asynchronous publications.

## Route reads and mutations

The local browser router discovers endpoints through paid index requests.
Mutation business logic verifies each advertisement signature against the
intended proposer principal before allowing OIDC credentials to reach the
signed endpoint. The destination transport is plain global fetch with the
OIDC token and no DPoP proof. Index discovery has its own PAID authenticated
fetch. Global fetch remains unchanged.

For infrastructure reads, the router selects a provider and then invokes PAID
authenticated fetch, which binds its proof to that provider URL and HTTP
method. The browser compiles parameterized MySQL queries with Kysely's
DummyDriver, sends them to mysql-http, and converts string/null SQL values into
RealWorld response types. OIDC tokens do not go to read providers.

Business logic enables `routerRetry` for read-only SQL POSTs and disables it
for mutations. A request that might already have committed must not be replayed
just because its response was lost. Identity management, including the current
user response, remains at the proposer rather than public replica SQL.

## Publish and follow updates

The MySQL proposer publishes a baseline and binlog deltas through its local
OCI conversion application to PAID storage. The replica follows signed
publications through the OCI provider's metered gateway, restores the baseline,
and replays binlogs using GTIDs. See the
[database proposer guide](../../../proposer-guide/database-proposer.md).

A successful mutation reflects committed primary data. Replica reads become
current asynchronously. The UI waits for dependent state to appear, with a
bounded timeout and an error if it does not. The E2E harness explicitly publishes its initial baseline after schema setup,
then uses the normal scheduler with one-minute deltas and bounded polling.
The weekly baseline schedule remains unchanged; production defaults retain
five-minute deltas. Tests do not use fixed sleeps or read primary rows as a
substitute for replication.

## Serve objects

Media is uploaded to KvStore under content-addressed SHA-256 CIDv1 identifiers.
The browser retrieves bytes using routed PAID authenticated fetch, verifies
the CID, and creates a Blob URL for display. Blob URLs are revoked when the
view no longer needs them. Service worker support is deferred.

Retention follows the market mechanism: interested parties may renew useful
objects or revive expired content. The proposer does not guarantee permanent
availability, and a database reference alone does not keep an object alive.

## Payment phases

Phase 1 uses CreditBalance fixtures for browser, index, storage and replication
identities. Guest browsing means no OIDC account is needed; it still consumes
paid infrastructure resources. The fixture is for development and testing.

The Phase 2 browser payment test uses a new wallet generated in Chromium. It
checks that its initial Sui devnet balance is zero, obtains real faucet funds,
transfers Sui to the exchange, purchases provider points, and redeems them at
the index, SQL replica, and object provider. It then exercises routed article
reads, authenticated Blob media, and the frontend's browser cashier integration.
The browser identity never receives CreditBalance fixture funding.

Run after the Phase 1 test, with the same image and cluster environment:

```sh
bash testing/realworld/deploy-payments.sh
bash testing/realworld/test-payments.sh
```

This requires public Sui devnet and faucet availability. The localhost test server
relays validated requests to the real devnet faucet because that faucet does not
allow browser CORS. Browser security stays enabled, and the wallet signs in the
browser. The deployment saves the original provider Helm values in a Secret;
`deploy.sh --reuse-routing` restores them before running Phase 1 again.

For local browser payment provisioning, pass a private cashier configuration file
to `frontend-server.ts` using `REALWORLD_CASHIER_CONFIG_FILE`. It accepts the
cashier's account mnemonic, payment methods, account origins, and manifest origin
overrides. The localhost server delivers that configuration at runtime with
`Cache-Control: no-store` and same-origin resource restrictions; it belongs to
the local operator and must not be
published as a shared site's configuration. Enable `REALWORLD_DEVNET_FAUCET=true`
and set the devnet payment's `suiFaucetUrl` to the frontend origin when using the
local faucet relay. The browser cashier obtains destination-bound PAID proofs;
proposer mutations continue to use OIDC through plain fetch.
