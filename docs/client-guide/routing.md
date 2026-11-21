# Routing

> [!WARNING] Agent generated docs
>
> This file is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

Goals:
- Discover service providers
- Provider reputation

## Functionality

Get the specification of a behavior or variant from a signature-checked OCI `oci://{any-oci}/{maintainer}/{name}:{tag}`.
Signature-checked means the authenticity of them MUST be checked like `verifyAnchor` of OCI. And it MUST match the `maintainer` field.

They can be arbitrary OCI repositories.
A behavior MAY have a swagger.yaml or swagger.json to define the API.
The usage of them are subject to their definition.

```proto
message Behavior {
  string name = 1;
  string maintainer = 2;
  string tag = 3;
}
message Variant {
  string name = 1;
  string maintainer = 2;
  string tag = 3;
}
```

For example, a signature-checked OCI functionality's may have the following files:

`oci://oci.example.com/bahi...aaa/sig-checked-oci/behavior:v0.1.2`:
- `swagger.json`: The swagger of an OCI registry
- `behavior.md`: Describing the behavior in markdown, with RFC2119 language

`oci://oci.example.com/bahi...bbb/myapp-images-of-blog-foo-bar/variant:kvstore-v0.2.3`:
- `behavior.json`: A link to the behavior repo
  - ```json
    {
      "behavior": {
        "name": "sig-checked-oci/behavior",
        "maintainer": "bahi...aaa",
        "tag": "behavior:v0.1.2"
      }
    }
  ```
- `variant.md`: Describing the SLA of data to receive, include rules like
  - Never return tampered data, which means signature invalid or not matching uploader JKT
  - Serve AWS US East within 30ms RTT and 10MB/s for 99% uptime until 2027-01-01T00:00:00
  - Serves all contents under an oci repo

Functionality is only a declaration. The implementation will be off the channel,
and will be in libraries in different languages, imported by an app author.

The storage of behavior and variant repos is itself a functionality. OCI providers can advertise themselves so that index will query them when requests come.

## Proposer

The design goal is to let a proposer to write its app to run in browser or native app in typescript.

To route a request, the app author passes its functionality directly to a local
fetch interceptor. The interceptor discovers providers from trusted indices and
calls the selected provider through the wrapped fetch.
```proto
message Functionality {
  Behavior behavior = 1;
  Variant variant = 2;
}
```

The interceptor replaces the request origin with the selected provider origin,
preserving the method, headers, path, query, and body. Authentication remains a
separate layer in the wrapped fetch or outproxy.

The proposer may become budget-aware and design its app to select different variants of functionalities to call. For example accept worse network connections or bandwidth speed when budget is low. But the router interface will only accept a single functionality to route.

## Router

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

Routing is a local library operation that can be used with any functionality.

The router owns discovery, functionality matching, origin/principal validation,
expiry checks, deduplication, request redirection, and retry behavior. It passes
eligible providers to an explicitly configured `ProviderRanker` sorting rule.
The rule receives candidates and returns its preferred order/subset. Changing
that rule preserves the router's shared validation, including expiry rejection.
There is no default rule: constructing the router without one raises an error.

The router searches indices for service providers of a functionality:
```proto
message SearchProviderRequest {
  Functionality functionality = 1;
  repeated Functionality provider_scorings = 2;
  int64 limit = 3;
  string offset = 4; // Pagination token
}
message SearchProviderResponse {
  repeated ProviderAdvertisement provider_advertisements = 1;
}
```

## Index

A service provider registers itself at an index by posting an advertisement.

```proto
message ProviderScore {
  Functionality scoring_functionality = 1;
  double score = 2;
}
message Provider {
  string origin = 1;
  CoinType coin_type = 2;
  CoinEnvironment coin_environment = 3;
  repeated Provider exchanges = 4;
  int64 price = 5;
  google.protobuf.Timestamp update_time = 6;
  google.protobuf.Timestamp expire_time = 7;
  string principal = 8;
  repeated ProviderScore scores = 9;
}
message ProviderAdvertisement {
  Functionality functionality = 1;
  repeated Provider providers = 2;
  string signature = 3;
}
```

The index will register some rankers, which will score each (Provider, Functionality) pair.
The scores can be saved to a database, or generated per request on the fly.
They will be used to rank the providers when returning to the router.

## Running the index and using local routing

The index stores exact `(behavior, variant)` identities in MySQL. Set `MYSQL_DSN`
(for example, `user:password@tcp(mysql:3306)/routing?parseTime=true`) and run the
infrastructure image's `/index` binary. It creates its table on startup. The
index listens on port 3000; expose it through the party's metered Envoy gateway.
The `charts/index` chart accepts an external database at `env.mysqlDsn`.

The service contract is `proto/index/v1/index.proto`; use its generated Connect
clients with either protobuf binary or protobuf JSON encoding. Register using
`IndexService.Advertise` (`POST /index.v1.IndexService/Advertise`), wrapping the
advertisement in the request’s `advertisement` field. Authenticate through the party's normal DPoP layer.
`signature` is a compact ES256 JWS with the public `jwk` in its protected header.
Its payload is the protobuf JSON encoding of `SignedAdvertisement`:
`{v: "paid.index.advertisement.v1", functionality, providers}`. Use protobuf
codecs for enum names, string-encoded 64-bit integers, and timestamps.
The signer must match the authenticated caller. Each provider’s `principal`
is required and included in the signed registration. An advertisement replaces that
caller's previous advertisement for the same functionality. Provider origins
must be HTTP(S) origins; expiry must be in the next 30 days. Requests are limited
to 1 MiB, 32 providers, and 8 exchanges per provider, nested at most two levels.

Search using `IndexService.SearchProvider`
(`POST /index.v1.IndexService/SearchProvider`) with a request containing
`functionality`, requested `providerScorings`, `limit` (1–100, default 20), and
`offset` from the previous response's `nextOffset`. Results contain
`providerAdvertisements`. Each provider includes its required `principal` and
index-generated `scores`, where each entry pairs a `scoringFunctionality` with
a numeric `score`. Registration requires empty `scores`, including for exchange
providers; search populates them. These search annotations are excluded from the
publisher’s signature: clear `scores` recursively before verifying the signed
registration fields. Expired advertisements are
excluded from search. Pagination reflects the current index contents.

The initial scoring implementation assigns the server's advertisement acceptance
time in Unix milliseconds, represented as a double. Higher scores rank first.
Configure the index’s enabled scorers through `ENABLED_SCORERS`, a JSON array of
`{implementation, functionality}` entries (`env.enabledScorers` in the chart).
The supported latency metric is `ingress-time`. Each search requests a list of
`providerScorings`; the index returns scores only for enabled functionalities
that match that list. Unsupported functionalities are ignored; no matches means
an empty result, not an error. The functionality identities come from startup
configuration, not hardcoded fixture identities.

Configure the router with trusted `indices` and an explicit `providerRanker`.
For averaging, choose `createAverageScoreRanker({ providerScorings })`. The rule
advertises the scoring functionality list that the router requests from indices.
It orders providers by the arithmetic mean of available configured scores;
unconfigured scores are ignored. Missing scores do not contribute to the mean,
and providers without matching scores are omitted by this rule. Duplicate
configured functionalities count once. The dummy rule averages raw scores
without normalization and breaks equal means by origin.

A different rule implements `{ providerScorings, rank(providers) }` and returns
an ordered subset of the supplied provider objects. Rules perform no discovery
or reusable validation. The router filters candidates before invoking the rule,
checks expiry again before forwarding, and deduplicates origins in the chosen
order. With averaging this retains the advertisement with the highest mean.
An unavailable index does not prevent using another index; failure of all
indices is an error. Indices currently have equal trust.

Functionality definitions remain signed OCI publications. Reuse the OCI
conversion library to verify the requested maintainer's anchor and the content
digest when loading them, as in `testing/routing/functionalities/oci/ts`.

For a local fetch interceptor, explicitly choose the rule and configure the router from
`applications/router`:

```typescript
const providerRanker = createAverageScoreRanker({ providerScorings })
const routedFetch = createRoutedFetch({ indices, providerRanker, fetch: authenticatedFetch })
```

Call the returned function
with `(input, init)`, like fetch. One interceptor handles all requests and
functionalities. Ordinary URLs pass through without discovery. Use
`https://paid.invalid/path` and set `init.functionality` to route a PAID request;
missing functionality is rejected before any network call. Routing metadata is
local and is removed before forwarding. The router asks the injected ranker for
ordered providers, then redirects and retries requests through the wrapped `fetch`.
The router captures its underlying fetch at construction, so the returned
interceptor can replace global fetch without recursively intercepting discovery.
It preserves the operation’s headers, method, path, query, and body. Request bodies
are buffered so browser uploads work through HTTP/1.1 gateways. Authentication
belongs to the wrapped fetch or outproxy. GET and HEAD can fail over to the next
ranked provider by default. Set `init.routerRetry = true` for a read-only POST
that is safe to replay, or `false` to disable retries for an operation. This
option is local metadata and is removed before forwarding. Routing parameters are
passed in `init.functionality` and aren’t encoded into operation headers.

Set `discoveryFetch` in the router configuration to authenticate index requests
independently of destination requests. It defaults to the configured `fetch`.
For example, a proposer mutation router can use PAID authenticated discovery
and plain global fetch to preserve its OIDC token at the destination.
The optional async `init.acceptProvider(provider, signedAdvertisement)` callback
lets business logic verify the advertisement against its intended proposer
principal before credentials reach any discovered endpoint. A rejected provider
is excluded before dispatch. The RealWorld example implements this policy and
sets `routerRetry = false` for mutations.

## Browser applications

`examples/echo-server` demonstrates an OCI-published browser app. Use
`proposer/app-packer` to bundle its frontend with trusted indices, scoring
functionalities, and the requested functionality. Download against the expected
proposer principal using the existing OCI signature verification; the packer
also verifies each layer before writing files locally. Its inline bundle opens
from `file://` without a local web server.

Wrap browser fetch with `createAuthenticatedFetch(customerKey)` from
`applications/client-auth`, then pass it to `createRoutedFetch`. Authentication
runs after routing and binds a fresh DPoP proof to the final URL and method.
Provision and fund the client's signing key separately; never embed a publisher's
private key in the frontend. The browser E2E uses CreditBalance fixtures and
requires neither cashier nor outproxy. Envoy gateways handle credential-free CORS preflights before authentication;
actual calls remain authenticated. The exchange, index, KvStore, OCI, and MySQL
replica charts default to `cors.allowOrigins: ["*"]` for browser access from any
origin, including `file://` (`Origin: null`). Set exact origins to restrict browser
access, or `[]` to disable service CORS. These policies use PAID authorization headers,
not cross-origin cookies. Public provider manifests retain explicit wildcard CORS
headers for discovery; Envoy bypasses its CORS filter on direct-response routes.
Go services do not add CORS response headers.
