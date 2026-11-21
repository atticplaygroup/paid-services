import { fromJson, toJson } from "@bufbuild/protobuf"
import { timestampDate } from "@bufbuild/protobuf/wkt"
import { FunctionalitySchema, type Provider, type ProviderAdvertisement } from "./proto/gen/es/index/v1/index_pb.js"
import { createIndexClient } from "./index-client.js"
import { sameFunctionality } from "./types.js"
import type { Fetch, Functionality } from "./types.js"
import type { ProviderRanker } from "./provider-ranker.js"
export type { Definition, Functionality, Fetch } from "./types.js"
export type { Provider, ProviderAdvertisement } from "./proto/gen/es/index/v1/index_pb.js"
export { createIndexClient }
export { createAverageScoreRanker, type ProviderRanker, type AverageScoreRankerConfig } from "./provider-ranker.js"

export interface RouterConfig {
  indices: string[]
  providerRanker: ProviderRanker
  fetch?: Fetch
  discoveryFetch?: Fetch
  timeoutMs?: number
}

export interface RoutedFetchOptions extends RouterConfig {
  maxAttempts?: number
  onAttempt?: (origin: string) => void
}

function requireRanker(config: RouterConfig): void {
  if (!config.providerRanker || typeof config.providerRanker.rank !== "function" || !Array.isArray(config.providerRanker.providerScorings)) {
    throw new TypeError("providerRanker must be explicitly configured")
  }
}

function isEligibleProvider(provider: Provider): boolean {
  let origin: URL
  try { origin = new URL(provider.origin) } catch { return false }
  return ["https:", "http:"].includes(origin.protocol) && !origin.username && !origin.password &&
    origin.pathname === "/" && !origin.search && !origin.hash && !!provider.principal &&
    !!provider.expireTime && timestampDate(provider.expireTime).getTime() > Date.now()
}

export type AcceptProvider = (provider: Provider, advertisement: ProviderAdvertisement) => boolean | Promise<boolean>

export async function discover(config: RouterConfig, functionality: Functionality, acceptProvider?: AcceptProvider): Promise<Provider[]> {
  requireRanker(config)
  if (!config.indices.length) throw new Error("no trusted indices configured")
  const fetcher = config.discoveryFetch ?? config.fetch ?? fetch
  const results = await Promise.allSettled(config.indices.map(async origin => {
    const response = await createIndexClient(origin, fetcher).searchProvider({
      functionality: fromJson(FunctionalitySchema, functionality),
      providerScorings: config.providerRanker.providerScorings.map(f => fromJson(FunctionalitySchema, f)),
      limit: 100n,
    }, { signal: AbortSignal.timeout(config.timeoutMs ?? 5000) })
    return response.providerAdvertisements
  }))
  if (results.every(r => r.status === "rejected")) throw new Error("all trusted indices failed")
  const candidates: Provider[] = []
  for (const result of results) if (result.status === "fulfilled") {
    for (const advertisement of result.value) {
      if (!advertisement.functionality || !sameFunctionality(toJson(FunctionalitySchema, advertisement.functionality), functionality)) continue
      for (const provider of advertisement.providers) {
        if (isEligibleProvider(provider) && (!acceptProvider || await acceptProvider(provider, advertisement))) candidates.push({ ...provider, origin: new URL(provider.origin).origin })
      }
    }
  }
  // Ranking rules only receive validated candidates. Keep reusable filtering
  // and origin deduplication here, independent of the selected sorting policy.
  const eligible = new Set(candidates)
  const unique = new Map<string, Provider>()
  for (const provider of config.providerRanker.rank(candidates)) {
    if (eligible.has(provider) && isEligibleProvider(provider) && !unique.has(provider.origin)) unique.set(provider.origin, provider)
  }
  return [...unique.values()]
}

export interface RoutedRequestInit extends RequestInit {
  functionality?: Functionality
  routerRetry?: boolean
  acceptProvider?: AcceptProvider
}
export type RoutedFetch = (input: RequestInfo | URL, init?: RoutedRequestInit) => Promise<Response>

// Route paid.invalid requests using the injected ranker. Authentication belongs
// to the wrapped fetch; routing metadata is never added to operation headers.
export function createRoutedFetch(options: RoutedFetchOptions): RoutedFetch {
  requireRanker(options)
  // Capture transport before callers optionally install this as global fetch.
  const fetcher = options.fetch ?? fetch
  const config = { ...options, fetch: fetcher }
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    const target = new URL(url, typeof location === "undefined" ? undefined : location.href)
    const functionality = init?.functionality
    // Ordinary requests retain their original input and transport semantics.
    if (target.hostname !== "paid.invalid") {
      if (!init || !["functionality", "routerRetry", "acceptProvider"].some(key => key in init)) return fetcher(input, init)
      const { functionality: _routingMetadata, routerRetry: _retry, acceptProvider: _accept, ...passthrough } = init
      return fetcher(input, passthrough)
    }
    if (!functionality) throw new TypeError("paid.invalid requests require a functionality")
    if (!["http:", "https:"].includes(target.protocol)) throw new TypeError("PAID routing requires HTTP(S)")
    const { functionality: _functionality, routerRetry, acceptProvider, ...requestInit } = init ?? {}
    const original = new Request(input, requestInit)
    const retry = routerRetry ?? ["GET", "HEAD"].includes(original.method)
    original.signal.throwIfAborted()
    // Passing a Request's ReadableStream as RequestInit.body turns ordinary
    // browser POSTs into streaming uploads, which Chromium requires HTTP/2 for.
    // Materialize the body once so HTTP/1.1 gateways work and retries keep bytes.
    // Firefox does not expose Request.body; GET/HEAD must still have no body.
    const body = ["GET", "HEAD"].includes(original.method) ? undefined : await original.clone().arrayBuffer()
    const providers = await discover(config, functionality, acceptProvider)
    if (!providers.length) return new Response("no matching provider", { status: 404 })
    let attempts = 0
    for (const provider of providers) {
      // A provider can expire during ranking or while an earlier attempt runs.
      if (!isEligibleProvider(provider)) continue
      if (attempts >= (options.maxAttempts ?? 10)) break
      attempts++
      original.signal.throwIfAborted()
      options.onAttempt?.(provider.origin)
      // Concatenation keeps a leading // in the path from changing authority.
      const request = new Request(provider.origin + target.pathname + target.search, {
        method: original.method, headers: original.headers, body,
        cache: original.cache, credentials: original.credentials,
        integrity: original.integrity, keepalive: original.keepalive,
        mode: original.mode, redirect: original.redirect,
        referrer: original.referrer, referrerPolicy: original.referrerPolicy,
        signal: original.signal,
      })
      try {
        const response = await fetcher(request, {
          signal: AbortSignal.any([original.signal, AbortSignal.timeout(options.timeoutMs ?? 5000)]),
        })
        if (response.status < 500 || !retry) return response
        await response.body?.cancel()
      } catch (error) { if (original.signal.aborted || !retry) throw error }
    }
    if (!attempts) return new Response("no matching provider", { status: 404 })
    throw new Error("routing attempts exhausted")
  }
}

// Generated protobuf codecs are shared with routing fixture consumers.
export { fromJson, toJson, toJsonString } from "@bufbuild/protobuf"
export { Code } from "@connectrpc/connect"
export { ProviderAdvertisementSchema, SignedAdvertisementSchema, SearchProviderRequestSchema, SearchProviderResponseSchema } from "./proto/gen/es/index/v1/index_pb.js"
