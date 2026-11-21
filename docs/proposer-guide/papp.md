# PAID App (pApp)

## What is a PAID App

A PAID App, aka pApp, is a way to serve web pages that use PAID services. It aims to provide:
- Easy developer experience
  - Send requests to https://paid.invalid, and the framework will do the rest
- Easy user experience
  - Shared client routing and funding configurations
- Secure serving
  - Content integrity
  - Runtime origin isolation by the browser

In general, it applies to native apps too.

### Try it now

(TODO) Visit the following web page for a Medium-like blog application (Conduit).

<!-- TODO: Run the Conduit app at a gateway, with a default user server embedded that runs on devnet, and uses a faucet when funds are below a threshold -->

## How will a pApp be served and used

A pApp can be served directly at any website like a dApp. If you serve your website directly, make sure to include a service worker like [here](../../applications/papp-gateway/src/sw.ts) to intercept requests to https://paid.invalid to connect to a user server and retrieve.

A dApp will need to connect to a wallet to sign transactions. Similarly, a pApp will need to connect to a user server to fund the requests. You can also connect to a public devnet one for demos.

Using a pApp gateway can ease the configuration sharing user experience and provide content integrity checks. Read [pApp gateway](../infra-guide/papp-gateway.md) for more.

## Should I migrate to a pApp?

## Migrating to a pApp

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

To turn a compatible browser app into a pApp, change its public read requests
to use `https://paid.invalid` and include the functionality that identifies the
service and data they need. Keep using ordinary `fetch`. The gateway installs
the service worker; it handles provider discovery, PAID authentication, and
payment through the user's own user server.

For reads whose API matches the provider's API, make two changes: replace the
origin and add `X-PAID-Functionality` to the read client's headers. You can replace
the origin with:

```sh
sed -i 's|https://reads.example.com|https://paid.invalid|g' src/read-client.ts
```

Apply the replacement and header addition to the read client or read-service
configuration. Login and mutations keep using your conventional backend.
Their API handlers,
authentication, authorization, and business logic do not need a PAID rewrite.

Then build and publish the frontend as a signed release. Users open it at a
stable pApp address, and the gateway verifies the published files before
running them. This guide covers the request changes first, then publishing and
running the app.

### Decide what to move

| Part of your application | Where it runs |
| --- | --- |
| HTML, JavaScript, CSS, and other static assets | Published as an immutable UnixFS directory; loaded through the pApp gateway |
| Public database reads | PAID database replicas, selected through a functionality |
| Public images and other objects | Content-addressed storage providers |
| Login, permissions, moderation, and writes | Your existing backend and identity provider |
| Provider selection, PAID credentials, and spending limits | Each user's user server |

Only publish data that may be copied and redistributed. Removing your copy
does not revoke copies already obtained by others. Keep private data and
credentials out of the frontend bundle and published database schemas.

Database reads from replicas are eventually consistent. After a write succeeds,
the new value may not appear until the proposer publishes it and the replica
imports it. Plan for this delay in the UI. See the
[database proposer guide](database-proposer.md) for publishing database changes.

### Prepare the frontend

Build your application into a static directory, such as `dist/`, with an
`index.html` at its root. Include the JavaScript, CSS, fonts, and other assets
needed to run it. Use relative or same-origin asset URLs so they resolve within
the published directory.

The gateway serves `index.html` for application navigations, which supports
client-side routes such as `/articles/123` and OIDC callbacks. Fetching an asset
still uses its path within the directory. Paths such as `/sw.js`,
`/bootstrap.js`, `/papp-manifest`, `/healthz`, and `/__papp/config`, and the
`/ipfs/` and `/ipns/` prefixes, belong to the gateway. Move conflicting app
endpoints or service workers before publishing.

Your server-rendered backend does not run inside the gateway. Export a static
frontend, or retain server-dependent features behind explicit backend URLs.
Ordinary external HTTP APIs can remain ordinary `fetch` calls, subject to the
browser's HTTPS and CORS rules.

#### Change the read origin

A pApp uses the browser's normal `fetch` API. For example, an existing SQL read
might look like this:

```ts
const response = await fetch("https://reads.example.com/sql", {
  method: "POST",
  headers: {
    "content-type": "application/json",
  },
  body: JSON.stringify({ sql, parameters }),
})
```

Change the URL to `https://paid.invalid/sql` and add `X-PAID-Functionality`.
The method, path, body, and response handling stay the same:

```ts
const response = await fetch("https://paid.invalid/sql", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "X-PAID-Functionality": JSON.stringify(appConfig.sql),
  },
  body: JSON.stringify({ sql, parameters }),
})
```

`paid.invalid` is a service-worker destination, not a server you deploy or a DNS
record you configure. Inside the pApp, the worker intercepts the request and
sends it to a provider selected for `X-PAID-Functionality`. That header contains
the JSON functionality identifying your service contract and data variant.
Set `appConfig.sql` to the functionality identity that your SQL providers
advertise. The header tells the worker which service and data to request.

No frontend PAID SDK is required. The optional `paidFetch(functionality, path,
init)` helper in `applications/papp-sdk/src/browser.ts` only constructs this URL and adds the functionality header; it
does not perform the routing or payment. Your app does not manage PAID keys,
provider accounts, or wallet connections.

The URL replacement preserves an API; it does not translate one. If your app
calls `/api/articles` but your PAID providers expose `/sql`, add a read adapter
that expresses the existing reads as SQL and maps the results to the shape your
UI expects. If providers already serve your read API, changing the origin and
adding the header is enough.

#### Request options and content URLs

Use normal request methods, headers, bodies, and abort signals. Set
`X-PAID-Retry: true` for requests safe to repeat, including read-only SQL POSTs.
Set it to `false` for requests that must not be replayed. A POST is not
necessarily a mutation; choose based on what the operation does.

Handle HTTP 402 by asking the user to review their user-server budget or
funding. The app cannot raise the user's spending limit itself. The optional
SDK `getDailyBudget()` helper lets you display the available budget.

Use `/ipfs/<cid>/<path>` on the app origin for immutable IPFS content.
`/ipns/<name>/<path>` additionally requires the gateway's IPNS resolution
configuration. These paths are also handled by the worker.

#### Leave mutations on your conventional backend

Keep mutation requests on their existing backend URLs. They remain ordinary
HTTP requests with your existing login credentials, payloads, responses, and
server-side permission checks. They do not go through `paid.invalid` and need
no PAID functionality header. Keep your identity provider, moderation, and
mutation handlers as they are.

```ts
// This request is unchanged when publishing the frontend as a pApp.
await fetch("https://api.example.com/api/articles", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ article }),
})
```

If your old frontend used relative backend URLs such as `/api/articles`, set
its backend base URL to `https://api.example.com` when deploying on the new
pApp origin. A relative URL now addresses the published app's origin.

Allow the pApp origin in backend CORS configuration. If you use cookies, review
cross-site cookie behavior and CSRF protection. Register the exact callback,
for example `https://<papp-id>.apps.example.com/callback`, with your OIDC provider.
Authorization, token, and JWKS endpoints must be reachable over HTTPS from the
browser. Keep issuer validation pinned to the issuer you trust.

Publication may lag mutations. Choose how to communicate that delay for your
application. The migrated upstream example preserves its existing redirects,
refetches, and cache behavior; it does not add publication polling.

For a complete example, see the migrated React app and its adapters in
[`examples/realworld-papp/frontend`](../../examples/realworld-papp/frontend).
It keeps upstream React components and Apollo hooks, runs GraphQL reads locally
with Kysely, and sends mutations and account operations to the independent
[`base app`](../../examples/realworld-papp/baseapp), which retains traditional Next.js
pages and public Prisma reads as well.

### Choose your app identity

An app's identity depends on its name and your proposer public key. Compute it
with `pappId(name, proposer)`, where `proposer` is the principal derived from that
key. Its browser address is:

```text
https://<papp-id>.apps.example.com/
```

Keep the name and proposer key stable across releases. The same identity keeps
the same browser origin on the same gateway, including local storage, login
state, and the user's app budget configuration. A different name or key creates
a different app. A different gateway hostname also changes the browser origin,
even when the pApp ID stays the same.

Open your app through any gateway you trust. The gateway supplies a generic
service worker; it does not register your app or keep per-app release files.
The worker discovers your release through the user's configured indices and
fetches its signed manifest and content from storage providers. You do not need
to submit anything to a gateway operator or run a gateway yourself.

If you want to run your own gateway, follow the optional
[gateway operator guide](../infra-guide/papp-gateway.md).

### Publish a release

A release needs three things: the frontend blocks in storage, its signed
manifest in content-addressed storage, and an advertisement pointing to that
manifest in an index used by your users. Publish in that order. All discovery
happens in the worker; the gateway configuration stays the same for every app.

#### 1. Upload the frontend and sign its manifest

Run the publishing code on your own machine or release server. Keep the proposer
private key there. Install dependencies with `bun install --frozen-lockfile` in
`applications/client-auth`, `applications/router`, `applications/ipfs`,
`applications/papp-sdk`. Publishing helpers live in `proposer/app-packer/papp.ts`.

The following example can be saved as `publish-papp.ts` at the repository root.
It reads a P-256 private JWK from `PROPOSER_KEY_FILE`, uploads the build to a
storage provider, and uploads the signed manifest to the same provider.
Installing the publishing helpers does not require running a gateway.
The publishing identity must already be funded at that storage provider; see
[client authentication](../client-guide/client-auth.md) and
[cashier setup](../client-guide/cashier.md).

```ts
import { packFiles, publishBlocks, signManifest, publishManifest } from "./proposer/app-packer/papp.ts"
import { createAuthenticatedFetch } from "./applications/client-auth/src/lib.ts"
import { pappId, proposerPrincipal, releaseTag } from "./applications/papp-sdk/src/lib.ts"

function required(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}
const jwk = await Bun.file(required("PROPOSER_KEY_FILE")).json()
const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
const algorithm = { name: "ECDSA", namedCurve: "P-256" }
const key = {
  privateKey: await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["sign"]),
  publicKey: await crypto.subtle.importKey("jwk", publicJwk, algorithm, true, ["verify"]),
}
const proposer = await proposerPrincipal(publicJwk)
const name = required("PAPP_NAME")
const id = await pappId(name, proposer)
const version = Number(required("PAPP_VERSION")) // Positive integer; increase per release.
if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid version")
const directory = process.env.PAPP_BUILD ?? "dist"
const files: Record<string, Uint8Array> = {}
for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, onlyFiles: true })) {
  files[path] = new Uint8Array(await Bun.file(`${directory}/${path}`).arrayBuffer())
}
if (!files["index.html"]) throw new Error("Build must contain index.html")
const packed = await packFiles(files)
await publishBlocks(packed.blocks, required("STORAGE_ORIGIN"), createAuthenticatedFetch(key))
const functionality = {
  behavior: { name: "papp-render", maintainer: proposer, tag: "v1" },
  variant: { name: id, maintainer: proposer, tag: releaseTag() },
}
const manifest = await signManifest(key, {
  name, proposer, functionality, version, webpage: `ipfs://${packed.root}`,
})
const publication = await publishManifest(manifest, required("STORAGE_ORIGIN"), createAuthenticatedFetch(key), key)
console.log(JSON.stringify({ id, root: packed.root.toString(), ...publication }, null, 2))
```

Set the variables for your deployment and run `bun publish-papp.ts`.
`STORAGE_ORIGIN` is the provider's HTTP(S) origin, not an S3 bucket URL.
`publishBlocks` uploads each raw or DAG-PB block through KvStore CAS and currently
requests 30 days of retention. Arrange continued retention or republishing with
your storage providers before it expires. Preserve every block needed by active
releases, including shared blocks when cleaning up older builds.

The script prints the manifest CID and the functionality to advertise. Its
variant name is your stable pApp ID, and its variant tag is a 23-digit UTC
timestamp (`YYYYMMDDHHMMSSnnnnnnnnn`), matching mysql-proposer's format.
`publishManifest` also publishes a signed KvStore variant anchor at
`papp/variants/<papp-id>/<tag>`. The anchor contains the manifest CID and binds
it to the proposer and timestamp tag. The worker selects the highest tag,
verifies the anchor, then checks the manifest hash, proposer signature, and
functionality (including the timestamp tag).

#### 2. Advertise the release

Register the printed functionality with storage providers that hold the signed
variant anchor, manifest, and frontend blocks. These providers expose KvStore
`GetProtectedValueAnchor` and serve raw blocks at
`/applications/user/public/value/<cid>`. The advertised origin is the storage
provider's origin, not the gateway hostname.

Use `POST /index.v1.IndexService/Advertise`. Include the functionality, provider
origin and principal, payment terms, update and expiry times, and an ES256
signature. Use the actual provider principal; it need not be your proposer
principal. The authenticated publisher must match the advertisement signer.
Follow the [registration contract](../client-guide/routing.md#running-the-index-and-using-local-routing)
for protobuf JSON encoding and signing.

Publish to indices your intended users trust and renew registrations before
expiry. The worker queries those indices for your pApp ID, considers the newest
registrations first, downloads the manifest from an advertised provider, and
checks its CID, signature, app identity, and functionality before loading code.
It can fall back to another provider or a previous valid release if a candidate
is unavailable or invalid. A higher manifest version alone does not promote a
release; publish its advertisement after the blocks and manifest are available.

The release advertisement also lets the worker find frontend block providers.
Your data APIs, such as SQL reads, keep their separate functionality identities
and registrations.

### Share the app

Users can enter an app ID at `https://apps.example.com/` or open the full app
address directly. On first access, the gateway asks for their user-server URL.
That server must be reachable and trusted by their browser over HTTPS. The
user configures their own wallet, indices, routing preferences, and budget;
you do not provision a shared wallet in the app. The current user server is
intended for a user's private network and does not provide caller authentication;
keep its wallet and configuration endpoints private. See the
[user-server guide](../client-guide/papp.md#run-the-user-server).

### Migrate and release safely

Start with a separate pApp origin alongside your current site. Move one public
read path at a time and compare its results against your existing application.
Keep backend permissions and moderation checks in place throughout the migration.

Before sharing the app, open it in a fresh browser profile and check:

- Initial user-server configuration, feed loading, and budget display.
- Login, logout, returning from the identity provider, and expired-session recovery.
- Reads from real replicas, writes through your backend, and the pending state
  until publication becomes visible.
- Image and other asset decoding, including bytes fetched from storage providers.
- Provider failures, an unreachable user server, and an exhausted budget.
- Chrome, Firefox, Edge, and Safari on the devices you intend to support.
  Playwright WebKit is useful Safari-engine coverage, but does not replace
  testing actual Safari.

For an update, rebuild the files and repeat publication with the same name and
key, a higher integer version, and a newer timestamp tag. Keep APIs and asset names compatible during rollout: open pages can request assets after a newer release
becomes discoverable, and the gateway does not pin all requests in a session to
one release. Content-hashed asset filenames help, but retain the old assets in
the new directory if existing pages still need them.

To roll back, publish a new, higher-version release pointing to the previous
known-good root with a newer timestamp tag, then advertise that functionality. That root's blocks must
still be available. Do not overwrite bytes under an existing CID or edit a signed
manifest in place.

### Troubleshoot a deployment

| Symptom | What to check |
| --- | --- |
| User server unavailable | Browser reachability, HTTPS certificate trust, user-server address, and whether the server is running. Forwarding a port alone does not establish certificate trust. |
| No valid pApp release | The user's configured indices, index authentication and funding, the release advertisement's variant name/tag, and the signed manifest CID and its storage providers. An `index discovery: 400` comes from the index request; inspect that response and index logs. |
| Manifest or content integrity failure | Proposer key and app ID, manifest signature, root CID, and whether every referenced block was uploaded without modification. |
| App loads, but SQL or media fails | The exact data functionality, provider advertisements, user-server routing preferences, provider availability, and the user's budget/funding. |
| A successful write is missing from the page | Proposer publication progress and replica import progress; confirm the UI is reading the intended replica variant. |
| Invalid login token | Application session expiry and backend token validation. Clear the rejected app session and sign in again; a PAID wallet balance does not renew an OIDC token. |
| A route works on the old site but fails here | Static build output, reserved gateway paths, absolute URLs pointing to the old host, backend CORS, and OIDC callback registration. |
