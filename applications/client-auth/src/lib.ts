import { DirectAccessTokenProvider, type AccessTokenProvider } from "./access-token.js"
export { AccessTokenError, CashierAccessTokenProvider, DirectAccessTokenProvider, type AccessTokenProvider, type AccessTokenRequest } from "./access-token.js"

/** Wrap after routing so each proof binds to the final provider and method.
 * The caller owns key storage and funding. Never put a publisher key in a bundle.
 */
export function createAuthenticatedFetch(keyOrProvider: CryptoKeyPair | AccessTokenProvider, fetcher: typeof fetch = fetch): typeof fetch {
  const provider = "getAccessToken" in keyOrProvider ? keyOrProvider : new DirectAccessTokenProvider(keyOrProvider)
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const token = await provider.getAccessToken({ url: request.url, method: request.method, headers: request.headers })
    request.headers.set("authorization", `Bearer ${token}`)
    // Redirects need a new destination-bound proof. Do not forward credentials.
    return fetcher(new Request(request, { redirect: "error" }))
  }) as typeof fetch
}
