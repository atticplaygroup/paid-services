# RealWorld pApp E2E

This suite builds and deploys only the traditional Next.js base app
and its independent pApp, using the PAID gateway and user server.
The library application and payment tests remain in `testing/realworld`.
Framework tests remain in `testing/papp`; shared fixture helpers live in `testing/shared`.

From the repository root, with Docker, kind, kubectl, Helm, Bun, and Node 22:

```bash
export CLUSTER_NAME=realworld-papp-demo
export KUBECONFIG=/tmp/realworld-papp.kubeconfig
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.34.0
bash testing/realworld-papp/build.sh
bash testing/realworld-papp/deploy.sh
bash testing/realworld-papp/test.sh
```

`IMAGE_PREFIX` defaults to `local` and `IMAGE_TAG` to `dev`. This suite builds
`realworld-papp`, not the library example's `realworld` image. Use a dedicated cluster;
`deploy.sh --reuse-routing` reuses its routing/storage infrastructure.
Only the base app's public `blog_*` schema is installed and published. No
library example server, frontend, mutation contract, or database tables are needed.
The fixture configuration has one SQL functionality and pins mutations to Next.js.

The UI scenario runs on the traditional app, then on Kubo and PAID-delivered
pApps, sharing the same OIDC account and mutation backend. It checks traditional
SSR article HTML, public reads, account updates, writes, comments, favorites,
follows/feed, links, navigation, reloads, deletion, logout and return login.
Traffic assertions recognize both ordinary GraphQL requests and persisted GET
queries, and reject remote public GraphQL reads from pApps. Publication waits
belong to the fixture; upstream redirects, refetches and caching are preserved.

Pagination tests compare Kysely cursor/offset behavior with live upstream Prisma,
including timestamp ties, separately from the library example's REST offset pagination.

CI runs through `e2e-realworld-papp.yaml` on Chrome, Firefox, Edge and WebKit.
To run one browser locally against a deployed fixture:

```bash
PAPP_BROWSER=firefox bash testing/realworld-papp/test.sh
```

Browsers retain origin and CORS checks. Temporary fixture certificates are
trusted through Chromium SPKI, a Firefox NSS profile, or WebKit's container CA
store. The fixture IdP accepts both exact frontend callback URLs. The browser
scenario allows 60 minutes; the Kubernetes job allows 70; CI allows 120.

For manual use after deployment:

```bash
bash testing/realworld-papp/launch.sh
```

Creating the kind cluster alone is insufficient: run `build.sh` and `deploy.sh`
above before launching, and keep `KUBECONFIG` pointing at that deployed cluster.
The launcher checks for the RealWorld pApp fixture before creating its demo pod.
If overriding the image, use `PAPP_DEMO_IMAGE=local/realworld-papp:dev`;
`local/realworld:dev` belongs to the library example and cannot run this demo.

The launcher forwards ports 3002, 3003, 3004 and 4000 and prints a browser command.
On first access, configure the user server as `https://localhost:3002`.
The demo uses fixture-funded credit and renews its release and SQL provider
advertisements every minute while running. Keep the terminal open; Ctrl-C removes
its pod. `PAPP_DEMO_IMAGE` overrides the image and `PAPP_DEMO_TLS_DIR` selects a
private directory containing `cert.pem` and `key.pem`.

For Firefox, the launcher exports the current public CA to a fingerprinted file
under `~/.cache/realworld-papp-demo` (or `$XDG_CACHE_HOME/realworld-papp-demo`) and
prints its path and SHA-256 fingerprint. In **Settings → Privacy & Security →
Certificates → View Certificates → Authorities**, remove any older **PAID fixture
CA**, import the printed file, and enable trust for identifying websites. Reload
the demo tabs. This trusts the certificate for all four demo HTTPS ports,
including the service worker's requests; a page-only exception is insufficient.
The default CA changes with every launch, so use the current run's file. An old
CA with the same name can cause Firefox's `SEC_ERROR_BAD_SIGNATURE` error.
For custom TLS, optionally include the issuing public `ca.pem` alongside
`cert.pem` and `key.pem` so the launcher can export it too.

Inspect failures or remove the dedicated cluster with:

```bash
bash testing/realworld-papp/diagnostics.sh
bash testing/realworld-papp/teardown.sh
```
