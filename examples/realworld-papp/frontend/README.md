# Migrated Conduit pApp

This is [jimleestone/next-real-world](https://github.com/jimleestone/next-real-world),
adapted for the PAID gateway and OIDC account model. See UPSTREAM.md
and LICENSE for the exact source revision and license.

Run `bun install --frozen-lockfile` here and in `../../../applications/papp-sdk`, then
`bun run build`. This generates Apollo hooks from the bundled GraphQL SDL before
Vite bundles the React SPA. Publish the contents of `dist/`, plus a `config.js`
that assigns `globalThis.PAID_CONFIG` with `sql`, `issuer`,
`oidcOrigin`, and the pinned `mutationOrigin`. No wallet belongs in that file.
The gateway serves deep links from the same index.html.

React components, compatible pages, hooks, cache merge policies, validation,
utilities, and styles are imported directly from `../baseapp`. GraphQL codegen
also reads its operation documents.
Keep that sibling source directory when building; it needs no pApp-specific
changes. The base app never imports this frontend.

Vite's `baseapp-integrations` plugin redirects the imported code's relative
references to the pApp's Apollo transport, constants, OIDC adapter, and generated
client. All other shared hooks and contexts remain single modules, and package
deduplication keeps React and Apollo on the frontend's installed versions.
Small adapters replace the Next router,
link, image, and metadata components. Article pages load with the existing
Apollo query instead of getServerSideProps. Public queries execute against
bundled SDL and Kysely resolvers; the SQL execution adapter preserves
`POST https://paid.invalid/sql` and `{sql,parameters}` / `{columns,rows}`.

The traditional Next.js app runs independently in [`../baseapp`](../baseapp).
Set `mutationOrigin` to that app's HTTPS origin. It owns account APIs, mutations,
and the published MySQL database; this frontend has no Next server or Prisma
runtime. It also retains conventional pages and public GraphQL reads for users
who prefer the original interface. Browser read resolvers remain local here.

Pagination preserves Prisma's upstream behavior: default offset pages,
inclusive cursors with zero offset, one skipped row with nonzero offset, and
backwards pages with negative offset. As in Prisma, cursors over nonunique
createdAt order locate the cursor row before slicing. The live MySQL comparison
runs from the repository root with
`DATABASE_URL=... bun test testing/realworld-papp/upstream-pagination.test.ts`; the library example's
REST offset pagination has its own end-to-end test.

Mutation redirects and refetches intentionally retain upstream behavior.
Publication is asynchronous: an immediate redirect can observe an older
replica and show the normal 404 until reloaded. The app does not wait for
publication. Markdown rendering and its upstream limitations are retained.
There are no custom avatar/attachment upload controls from the old demo;
the upstream app accepts image URLs and Markdown images. Gateway media
retrieval is independently covered by the pApp smoke test.
