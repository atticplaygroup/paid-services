# RealWorld pApp variant

The wrapped webpage functionality serves the UnixFS root named by `webpage` in
the proposer's signed release manifest. The root contains `index.html`, Vite assets under `assets/`,
and `config.js`. Configuration pins the traditional mutation endpoint and the
SQL/object functionalities. It contains no wallet or private PAID client key.
The frontend reads its daily budget through `papp-budget`. It reuses the
upstream next-real-world React components and Apollo operations. Public GraphQL
queries execute locally with Kysely through the pApp SQL publication; the
pinned base app provides OIDC accounts and Prisma mutations alongside its
traditional Next.js pages and read APIs. User IDs are
string OIDC subjects, while article and comment IDs remain integers.

Release variant tags use the fixed-width UTC timestamp format
`YYYYMMDDHHMMSSnnnnnnnnn`. Each variant is a proposer-signed KvStore anchor at
`papp/variants/<papp-id>/<tag>` containing the signed release manifest CID.
The gateway orders tags descending and verifies the anchor before retrieving
the content-addressed manifest. The signed manifest includes the same
functionality and timestamp tag, preventing tag substitution.
