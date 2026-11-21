# pApp framework E2Es

These tests exercise the PAID gateway, service worker, user server, IPFS, and
metered routing/storage with a minimal static probe. They do not import,
build, deploy, or inspect RealWorld, its database schema, its mutation API,
OIDC, Prisma, Vite, or React. Application E2Es live in `testing/realworld-papp`; library E2Es live in `testing/realworld`.

- `browser-smoke.test.ts`: cold start, saved worker configuration, metering,
  wallet isolation, POST/HEAD/GET and decoded media.
- `releases.test.ts`: publication while an asset is in flight, state and
  permission persistence, cross-app isolation, user-server outage/restart,
  budget exhaustion/recovery, invalid manifests and corrupted blocks.
- `ipfs-milestones.test.ts`: verified UnixFS retrieval through Kubo.

The probe uses the public pApp SDK to display its budget. It has no business
logic. Both Kubo and PAID storage delivery are tested in Chrome, Edge, Firefox,
and WebKit by `.github/workflows/e2e-papp-framework.yaml`.

```bash
export CLUSTER_NAME=papp-framework
export KUBECONFIG=/tmp/papp-framework.kubeconfig
kind create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" --image kindest/node:v1.34.0
bash testing/papp/build.sh
bash testing/papp/deploy.sh
PAPP_BROWSER=chrome bash testing/papp/test.sh
```

The framework image contains only framework libraries and test infrastructure.
Deployment uses the existing routing fixture, including its index database;
it does not deploy any application database or application server. Test keys
and routing configuration are mounted at `/etc/dpop-keys` and `/etc/routing`.

`gateway-fixture.ts` provides reusable publication, TLS, user-server and gateway
setup. It contains no application-specific setup or assertions. The RealWorld
fixture supplies its own built files, identity provider, mutation proxy, and
UI readiness assertion on top of this infrastructure helper. Framework
assertions run only in this directory, never as hooks in application tests.
