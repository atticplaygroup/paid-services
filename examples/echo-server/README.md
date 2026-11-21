# Browser echo example

`bun install` then `bun run start` runs the Bun echo server on port 3000.
Expose it through a PAID party's authenticated, metered gateway. The behavior
and variant repositories are in `behavior/` and `variant/`; publication adds a
`behavior.json` link naming the signed behavior's maintainer, name, and tag.

Use `proposer/app-packer` to bundle `frontend/index.ts` with a configuration:

```ts
const files = await packFrontend("examples/echo-server/frontend/index.ts", {
  indices: [indexOrigin], providerScorings: [scoringFunctionality], functionality,
}, await Bun.file("examples/echo-server/frontend/index.html").text())
await publishFiles(publisherClient, { maintainer: proposerPrincipal, name: "echo/frontend", tag: "v1" }, files)
const entry = await downloadToDirectory(readerClient, publication, newDirectory)
```

The clients are `KvstoreClient` instances with `createAuthenticatedFetch(key)`.
The publisher client also receives its signing key. The downloader supplies the
expected proposer principal independently of the downloaded content. The toolkit
uses the existing OCI anchor verification and checks each layer's digest before
writing to a fresh directory. It bundles JavaScript inline for `file://` use.

A local browser launcher provisions `globalThis.PAID_CLIENT_KEY` with a funded
P-256 private JWK before the page's scripts run. This is a client signing key, separate
from publication keys; no private key is baked into the signed frontend. The
browser imports it and wraps fetch with DPoP authentication. The router uses configured trusted indices and an explicitly selected
`createAverageScoreRanker({ providerScorings })` rule. Discovery, expiry checks,
and deduplication remain in the router when another sorting rule is chosen. A single router
accepts all requests: ordinary URLs pass through; `https://paid.invalid/echo`
with `init.functionality` selects the echo functionality for that request. Routing happens
first so proofs bind to the selected provider. No proxy or cashier is needed.
See `testing/browser/e2e-browser.test.ts` for an executable launcher and
CreditBalance funding fixture; real deployments must provide their own key
provisioning and funding.
