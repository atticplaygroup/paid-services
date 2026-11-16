# pApps and the user server

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

A pApp is an ordinary frontend served from a verified UnixFS directory on
`https://<papp-id>.<gateway>`. Its stable identity is a CIDv1 using the JSON codec
and SHA-256 of `JSON.stringify([name, proposer])`. Releases keep that identity,
origin, storage, and configured budgets. The gateway origin is trusted to install
the service worker correctly. App content and signed manifests are verified
before execution. Updates may mix assets across releases; version pinning is not supported.

A pApp uses ordinary `fetch`; its worker wraps the SDK. Optional helpers in
`applications/papp-sdk/src/browser.ts`, including
`paidFetch(functionality, path, init)`, send ordinary requests to
`https://paid.invalid` with `X-PAID-Functionality`. `getDailyBudget()` returns
`{ dailyBudget, spent, remaining }` as decimal strings. `navigate(pappId)` invokes
the rendering functionality and navigates to the verified target origin.
`X-PAID-Retry: true` permits retrying read-only SQL POSTs; writes should use false.
Traditional OIDC mutations go directly to the proposer URL pinned by the app.

The worker installs before application code loads. On first access it navigates
to `config.<gateway>`, where the user enters a user-server URL. That origin saves
the address and remembers visited apps. A redirect returns the address to the
app's worker, which stores it in IndexedDB with a persistent worker profile.
Existing CacheStorage configuration migrates on first use.
The bounce carries configuration only; each provider request obtains its own
URL/method-bound proof through `/token`. The user server's `/outproxy` transports
the resulting request, allowing HTTPS apps to use providers on private networks.
No wallet or private PAID client key is sent to the application.

Release discovery runs in the worker. It queries the user's indices for the app
ID and selects the highest timestamp variant tag across the indices. It fetches
and verifies the proposer's KvStore variant anchor at
`papp/variants/<papp-id>/<tag>`, then retrieves the signed manifest using the
anchor's CID and verifies its content hash, signature, functionality, and app identity. The
gateway needs no app registry or release directory. Initial index discovery is
charged to the app's discovery profile before its proposer is known; manifest
reads use the advertised proposer and application requests use the verified
proposer. All these profiles share the app's spending limit.

## Use the SDK directly

For an application that manages its own PAID access, import `createPaidClient`
from `applications/papp-sdk/src/lib.ts`. Supply the routing configuration and
an `AccessTokenProvider` (for example `CashierAccessTokenProvider`) or a client
key pair. The caller owns credential storage and funding.

```ts
const client = createPaidClient({ indices, providerScorings }, tokenProvider)
const response = await client.fetch("https://paid.invalid/sql", {
  functionality: sqlFunctionality,
  method: "POST",
  routerRetry: true, // Only for a read-only query.
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sql: "SELECT title FROM articles", parameters: [] }),
})
```

The SDK discovers and ranks providers, then obtains authorization bound to the
selected provider URL and method. `client.conventionalFetch` pays for discovery
but preserves the operation's original authorization, such as an OIDC token.
For that path, supply `acceptProvider` to verify the intended proposer before
sending credentials; `verifyProposer(provider, advertisement, principal)` verifies
the advertisement's signature and provider membership. Disable retries for writes.
An optional transport argument lets adapters use a user-server outproxy.

The service worker uses this same client with user-server credentials and
transport. Application SQL mapping, login and mutation payloads belong to the
application.

## Run the user server

Install dependencies in `applications/cashier`, `applications/client-auth`,
`applications/router`, and `applications/user-server` with `bun install
--frozen-lockfile`. Set `CASHIER_CONFIG_FILE` to a private cashier JSON file (see
[cashier](cashier.md)), `USER_SERVER_DATABASE` to a durable SQLite path, and
`USER_SERVER_CONFIG` to JSON with `indices`, `providerScorings`, `dailyBudget`,
optional `appPercentages`, and optional `proposerPercentages`. Then run:

```sh
bun applications/user-server/src/server.ts
```

Use its configuration page to edit routing preferences and budgets and inspect
wallet details. Its API exposes `/config`, `/wallet`, `/budget`, `/token`, and
`/outproxy`; worker calls identify `X-PAID-App`, `X-PAID-Proposer`, and
`X-PAID-Profile`. Cashier profiles derive separate client identities from the
server's master secret. Successful provider deposits add spending records in
SQLite. Budgets reset at UTC midnight; app and proposer percentages constrain
the shared total. Remaining provider points are treated as already spent.
Concurrent requests and crashes can affect budget accounting precision.
Caller authentication is not implemented; run this deployment on a user's private network.

For Kubernetes, build `docker/user-server.Dockerfile`, create a Secret containing
`config.json`, and install `charts/user-server` with `walletSecret` naming it.
The chart provisions persistent storage and an optional HTTPS Ingress. A private
HTTPS endpoint must be reachable from the browser. For local TLS, server processes
also accept `TLS_CERT` and `TLS_KEY` paths.

## Publish your own app

For frontend preparation, release publishing, gateway operation, and migration
from an existing backend, follow the [proposer pApp guide](../proposer-guide/papp.md).

## Verify

`testing/realworld-papp/test.sh` runs the migrated application's UI and
pagination tests against fixtures created by `testing/realworld-papp/deploy.sh`.
It tests the traditional base app and the independent pApp: guest reads, OIDC,
article/profile/editor navigation and reloads,
settings, comments, favorites, follows/feed, and deletion. The UI scenario
runs with Kubo content first, then repeats with PAID content delivery.
The `RealWorld pApp end-to-end` workflow runs this application suite in
Chrome, Firefox, Edge, and WebKit (Safari engine coverage).
Set `PAPP_BROWSER=chrome|firefox|edge|webkit` for local runs.

Framework E2Es run independently through `testing/papp/test.sh` and the
`pApp framework end-to-end` workflow. They publish a minimal static probe
and cover service-worker bootstrap, POST/HEAD/GET, decoded media,
publications, budgets, recovery, and origin isolation. Their image and
routing/storage deployment contain no RealWorld application or fixtures.
See [the framework test guide](../../testing/papp/README.md).
