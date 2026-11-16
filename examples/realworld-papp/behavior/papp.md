# pApp rendering v1

A pApp has a stable CIDv1 JSON identity derived from `[name, proposer]` and is
served on its own HTTPS origin. The gateway installs its trusted worker before
executing content. The signed release manifest contains `name`, `proposer`,
`functionality`, numeric `version`, and an immutable `ipfs://` webpage root.
The variant wraps that webpage-serving functionality. All blocks must match
their CIDs before document execution. New navigations discover releases through
index SQL and verify the manifest against the requested app identity.

Requests to `https://paid.invalid` carry JSON `X-PAID-Functionality` metadata.
The worker routes and authenticates reads through the user's server. The
`papp-budget` behavior returns decimal daily budget, spent deposits, and remaining
budget. The `papp-render` behavior at `/render?id=<papp-id>` returns the target
app origin after manifest verification. Clients navigate to the returned URL.
Traditional authenticated mutations use the proposer endpoint embedded in the
published app configuration; they do not pass through PAID routing or retries.
