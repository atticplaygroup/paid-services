# RealWorld pApp reads

Public GraphQL queries execute in the browser against the bundled schema and
Kysely resolvers. Only parameterized read-only POST requests to
https://paid.invalid/sql access infrastructure. The SQL transport and response
remain {sql, parameters} and {columns, rows}, with non-null cells encoded as
strings and SQL NULL as null. Tables in the base app’s public-schema.sql contain no email,
password, token, or OIDC session data. User IDs are string OIDC subjects;
article and comment IDs remain integers.

Preserve upstream filters, createdAt ordering, cursor inclusion, offset and
backwards pagination. Mutations and currentUser/checkUsername go directly to
the pinned Next.js backend, which verifies OIDC tokens and uses Prisma. The pApp never uses the base app’s public GraphQL reads or server-rendered pages.
