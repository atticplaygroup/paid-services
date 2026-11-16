# Traditional Conduit base app

Imported from jimleestone/next-real-world at
`ed60a30ce642a4544ffdcb5898ef80ee67147f1d` (MIT; see LICENSE).
This application retains upstream Next.js pages, SSR article rendering, Apollo
public reads, and Prisma mutations. The separate `../frontend` consumes its
published public database through PAID SQL and calls this app's conventional
account/mutation APIs. The base app does not depend on the pApp's implementation.

The fixture adaptations replace password authentication with OIDC, key users by
string subjects, and keep credentials/email with the IdP. `public-schema.sql`
contains only public data; mysql-proposer publishes the selected database using
its existing schema-level controls. Upstream read, mutation, cache, redirect,
and pagination behavior is otherwise retained.

Install with `bun install --frozen-lockfile`, build with `bun run build`, and run
with Node 22 using `bun run start`. Set `DATABASE_URL`, `OIDC_ISSUER`, optional
`OIDC_BACKCHANNEL_URL` for backend JWKS access, and `OIDC_BROWSER_ORIGIN` for the
browser-facing IdP (fixture default `https://localhost:4000`). `OIDC_AUDIENCE`
defaults to `realworld`. `BASE_URL` is the internal SSR API origin, defaulting to
`http://127.0.0.1:3000`; browser GraphQL requests use same-origin `/api`.
Register the exact `/callback` URLs for both frontends at the IdP. The fixture
IdP supports an `OIDC_CALLBACKS` JSON array of allowed callbacks, or the original
single `OIDC_CALLBACK` setting. Account and GraphQL APIs allow browser CORS.
Install `public-schema.sql` before starting the application.

`testing/realworld-papp/test.sh` exercises this traditional UI and both pApp
content-delivery modes against this same backend, including server-rendered
article HTML, guest reads, OIDC, settings, writes, navigation, and reloads.
Publication waits remain in the pApp test fixture, not application behavior.
