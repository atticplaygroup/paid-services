# PAID RealWorld (library approach)

A browser read application and proposer mutation application implementing the
RealWorld blog API. Follow the [tutorial](../../docs/tutorials/proposer/realworld/overview.md)
and [deployment/E2E walkthrough](../../testing/realworld/README.md).

`server.ts` accepts OIDC-authenticated mutations and publishes only public data
from `schema.sql`. `read.ts` compiles parameterized Kysely queries using
DummyDriver. `client.ts` runs them through routed, authenticated replica access;
it independently discovers proposer endpoints and verifies their signed
advertisements before sending OIDC tokens. `frontend-server.ts` serves the UI
on localhost HTTP for development; deploy the frontend behind HTTPS elsewhere.

The standalone mutation server takes `MYSQL_URL`, `OIDC_ISSUER`, optional
`OIDC_BACKCHANNEL_URL` and `OIDC_AUDIENCE`, and `PORT` (default 3000). The frontend
takes `REALWORLD_CONFIG_FILE`, optional `REALWORLD_CLIENT_KEY_FILE` for a local
fixture launcher, or `REALWORLD_CASHIER_CONFIG_FILE` containing a cashier JSON
configuration for local browser payments, and `PORT` (default 3001). The cashier
runs inside the browser and derives a different PAID identity for each provider
hostname. `REALWORLD_DEVNET_FAUCET=true` enables a local relay to the public Sui
devnet faucet; set the payment method's `suiFaucetUrl` to the frontend origin.
Never bake publication keys or
browser payment credentials into a shared frontend bundle.

The tutorial fixture IdP supplies registration/password adapters for the standard
RealWorld API collection. Integrating another IdP requires adapting those
identity-management endpoints (`/register`, password `/token`, `/account`) to
that provider; ordinary browser login uses authorization code with PKCE.

This example uses the PAID client library directly. The independent
pApp migration lives in [`../realworld-papp`](../realworld-papp/README.md).
