# Client authentication library

Browser-safe token providers shared by the fetch interceptor and outproxy server.
No HTTP listener, proxy transport, TLS interception, or Bun/Node server imports.

```ts
import {
  createAuthenticatedFetch,
  DirectAccessTokenProvider,
  CashierAccessTokenProvider,
} from "@paid/client-auth"

const tokens = new DirectAccessTokenProvider(keyPair)
const authenticatedFetch = createAuthenticatedFetch(tokens)
// Passing keyPair directly is shorthand for a DirectAccessTokenProvider.
```

For cashier-backed tokens, construct
`new CashierAccessTokenProvider(cashierAddress, cashierPrincipal, fetch)` and pass
that provider to `createAuthenticatedFetch`. The caller configures and funds its
identity; the library does not derive or store private keys.

The interceptor preserves request headers and bodies, injects a fresh Bearer
proof, and rejects redirects to avoid forwarding a destination-bound proof.
Pass it to the router as the wrapped fetch so authentication happens after
provider selection. Outproxy uses the same providers with its own forwarding
and TLS transport.
