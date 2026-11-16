# RealWorld pApp migration

This example migrates [next-real-world](https://github.com/jimleestone/next-real-world)
to the PAID gateway and user server. It is independent of the
[library example](../realworld/README.md).

- [`baseapp/`](baseapp/README.md) retains the traditional Next.js application,
  Prisma reads and mutations, and OIDC accounts. Its public database is exported
  using mysql-proposer's schema selection.
- [`frontend/`](frontend/README.md) builds the independent React pApp. Public
  GraphQL operations execute locally with Kysely and use `https://paid.invalid/sql`.
  A trusted service worker and user server handle PAID access. Account and
  mutation requests go directly to the configured Next.js base app.

The pApp does not import the library example's client or read implementation.
Application deployment and tests live in [`testing/realworld-papp`](../../testing/realworld-papp/README.md).
Framework tests remain in `testing/papp`.
