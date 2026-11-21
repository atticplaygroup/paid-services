# Browser echo E2E

Run `build.sh`, `deploy.sh`, and `test.sh` with `CLUSTER_NAME` and `KUBECONFIG`
pointing at a kind cluster. `.github/workflows/e2e-browser.yaml` runs this in CI.
Use `testing/routing/diagnostics.sh` for failure diagnostics. For an existing
routing fixture, `deploy.sh --reuse-routing` only installs the echo workloads.

The suite reuses the routing fixture's real MySQL index, signed OCI storage,
and metered gateways. Echo and index share one fixture party's meter/account.
Inherited OCI fixture outproxies are scaled to zero before the browser test: publication,
download, registration, discovery, and echo requests use DPoP fetch interceptors.
Fixtures fund keys through CreditBalance; no cashier is involved.

The test publishes behavior and variant definitions under distinct maintainers,
bakes trusted indices, scoring, and functionality into an inline frontend bundle,
publishes it under the proposer's principal, and downloads it through the existing
OCI anchor verification. Chromium opens the downloaded file with normal browser
security, receives a separate client signing key through its launcher, and discovers
and calls the echo provider. It checks displayed Unicode messages, final-target
DPoP proofs, distinct proofs per request, CORS preflight handling, and rejection
of unsigned and unfunded requests.

Run focused checks before building images:

```bash
bun test applications/client-auth/src proposer/app-packer applications/router/src applications/oci/src/storage/kvstore.test.ts
go test ./infrastructure/internal/authz-http ./infrastructure/pkg/connecthttp
```
