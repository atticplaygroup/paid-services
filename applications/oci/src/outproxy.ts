// Outproxy owns outbound service authentication.
export function createOutproxyFetch(outproxyAddress: string) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, { ...init, proxy: outproxyAddress })
}
