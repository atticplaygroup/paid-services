import { createAuthenticatedFetch, type AccessTokenProvider } from "../../client-auth/src/lib.ts"
import { createRoutedFetch, createAverageScoreRanker, type Functionality } from "../../router/src/lib.ts"

export interface PaidClientConfig {
  indices: string[]
  providerScorings: Functionality[]
  timeoutMs?: number
}

/** Shared client for library consumers and service-worker adapters.
 * The caller owns credentials and funding; transport may be a user-server outproxy.
 */
export function createPaidClient(config: PaidClientConfig, credentials: CryptoKeyPair | AccessTokenProvider, transport: typeof fetch = globalThis.fetch) {
  const authenticatedFetch = createAuthenticatedFetch(credentials, transport)
  const routing = {
    indices: config.indices,
    providerRanker: createAverageScoreRanker(config),
    discoveryFetch: authenticatedFetch,
    timeoutMs: config.timeoutMs ?? 35000,
  }
  return {
    /** Authenticated transport for bootstrap reads before routing is available. */
    authenticatedFetch,
    fetch: createRoutedFetch({ ...routing, fetch: authenticatedFetch }),
    /** Paid discovery with conventional provider requests, preserving caller authorization.
     * Set acceptProvider to pin the intended proposer before sending credentials.
     */
    conventionalFetch: createRoutedFetch({ ...routing, fetch: transport }),
  }
}
