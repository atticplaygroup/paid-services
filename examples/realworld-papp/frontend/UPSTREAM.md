# Upstream source

Imported from https://github.com/jimleestone/next-real-world at `ed60a30ce642a4544ffdcb5898ef80ee67147f1d`.
The upstream MIT license is in LICENSE.

React components, compatible pages, hooks, cache policies, and mutation logic
are imported from the sibling baseapp rather than copied. GraphQL operation
documents are reused at codegen time. Frontend-owned adapters provide browser
SQL reads, SPA routing, configuration, and OIDC; the baseapp has no dependency
on this pApp.
