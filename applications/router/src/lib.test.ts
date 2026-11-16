import { expect, test } from "bun:test"
import { createRoutedFetch, createAverageScoreRanker, discover as discoverProviders, type RouterConfig, type RoutedFetchOptions, type Functionality } from "./lib.ts"
const f: Functionality = { behavior: { name: "api", maintainer: "a", tag: "v1" }, variant: { name: "data", maintainer: "b", tag: "v1" } }
const ingressScoring: Functionality = { behavior: { name: "scoring", maintainer: "alice", tag: "v1" }, variant: { name: "ingress-time", maintainer: "bob", tag: "v1" } }
const ranked = (origin: string, score: number, functionality = f) => ({ functionality, signature: "signed", providers: [{ origin, principal: "publisher", expireTime: new Date(Date.now() + 60000).toISOString(), scores: [{ scoringFunctionality: ingressScoring, score }] }] })
// Composition fixture: the router and ranker share a mocked transport.
function createRoutingFixture(options: { providerScorings: Functionality[] } & Omit<RoutedFetchOptions, "providerRanker">) {
  return createRoutedFetch({
    ...options,
    indices: options.indices, providerRanker: createAverageScoreRanker(options), fetch: options.fetch,
    timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts, onAttempt: options.onAttempt,
  })
}
const discover = (config: { providerScorings: Functionality[] } & Omit<RouterConfig, "providerRanker">, functionality: Functionality) => discoverProviders({ ...config, providerRanker: createAverageScoreRanker(config) }, functionality)

test("discovery authentication is separate and application authorization precedes credential delivery", async () => {
  const destinations: string[] = []
  const routed = createRoutingFixture({
    indices: ["https://index"], providerScorings: [ingressScoring],
    discoveryFetch: async (input, init) => {
      expect(new Request(input, init).headers.has("authorization")).toBe(false)
      return Response.json({ providerAdvertisements: [ranked("https://impostor", 20), ranked("https://proposer", 10)] })
    },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      destinations.push(request.url)
      expect(request.headers.get("authorization")).toBe("Bearer oidc")
      expect(init).not.toHaveProperty("routerRetry")
      expect(init).not.toHaveProperty("acceptProvider")
      return new Response(null, { status: 201 })
    },
  })
  expect((await routed("https://paid.invalid/articles", {
    functionality: f, method: "POST", headers: { authorization: "Bearer oidc" },
    acceptProvider: async (provider, advertisement) => advertisement.signature === "signed" && provider.origin === "https://proposer",
  })).status).toBe(201)
  expect(destinations).toEqual(["https://proposer/articles"])
})

test("explicit retry enables SQL POST failover and can disable GET failover", async () => {
  for (const [method, routerRetry, expected] of [["POST", true, 2], ["POST", false, 1], ["GET", false, 1], ["GET", undefined, 2]] as const) {
    let attempts = 0
    const routed = createRoutingFixture({
      indices: ["https://index"], providerScorings: [ingressScoring],
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [ranked("https://dead", 20), ranked("https://live", 10)] })
        attempts++
        if (method === "POST") expect(await request.text()).toBe("read-only query")
        return new Response(null, { status: new URL(request.url).hostname === "dead" ? 503 : 200 })
      },
    })
    expect((await routed("https://paid.invalid/sql", { functionality: f, method, routerRetry, body: method === "POST" ? "read-only query" : undefined })).status).toBe(expected === 2 ? 200 : 503)
    expect(attempts).toBe(expected)
  }
})
test("merges equally trusted indices, rejects mismatches, deduplicates origins", async () => {
  const providers = await discover({ providerScorings: [ingressScoring], indices: ["http://bad", "http://one", "http://two"], fetch: async input => {
    const host = new URL(input.toString()).hostname
    if (host === "bad") throw new Error("offline")
    return Response.json({ providerAdvertisements: host === "one" ? [ranked("https://a", 10), ranked("https://other", 100, { ...f, variant: { ...f.variant, tag: "other" } })] : [ranked("https://b", 20), ranked("https://a", 15)] })
  } }, f)
  expect(providers.map(p => p.origin)).toEqual(["https://b", "https://a"])
})
test("local interceptor queries indices, retries reads, and preserves headers for wrapped fetch", async () => {
  const attempts: string[] = []
  const headers = { authorization: "caller header", "x-operation": "original" }
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], onAttempt: origin => attempts.push(origin), fetch: async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") {
      expect(request.headers.has("x-operation")).toBe(false)
      return Response.json({ providerAdvertisements: [ranked("https://dead", 20), ranked("https://live", 10)] })
    }
    expect(Object.fromEntries(request.headers)).toEqual(headers)
    expect(new URL(request.url).pathname + new URL(request.url).search).toBe("//attacker/file?x=1")
    if (new URL(request.url).hostname === "dead") throw new Error("offline")
    return new Response("file")
  } })
  expect(await (await routed("https://paid.invalid//attacker/file?x=1", { functionality: f, headers })).text()).toBe("file")
  expect(attempts).toEqual(["https://dead", "https://live"])
  expect(headers.authorization).toBe("caller header")
})
test("local interceptor does not replay a write after ambiguous network failure", async () => {
  let writes = 0
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [ranked("https://a", 20), ranked("https://b", 10)] })
    writes++
    throw new Error("connection lost")
  } })
  await expect(routed("https://paid.invalid/write", { functionality: f, method: "POST", body: "payload" })).rejects.toThrow("connection lost")
  expect(writes).toBe(1)
})
test("local interceptor delivers the original write body, query, and headers once", async () => {
  let writes = 0
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [ranked("https://provider", 1)] })
    writes++
    expect(request.method).toBe("PUT")
    expect(request.url).toBe("https://provider/write?version=1")
    expect(request.headers.get("content-length")).toBe("14")
    expect(request.headers.get("x-original")).toBe("kept")
    expect(await request.text()).toBe("original bytes")
    return new Response(null, { status: 201 })
  } })
  const original = new Request("https://paid.invalid/write?version=1", { method: "PUT", body: "original bytes", headers: { "content-length": "14", "x-original": "kept" } })
  expect((await routed(original, { functionality: f })).status).toBe(201)
  expect(original.bodyUsed).toBe(false)
  expect(writes).toBe(1)
})

test("routing omits GET/HEAD bodies when Request.body is unavailable in Firefox", async () => {
  const NativeRequest = globalThis.Request
  class FirefoxRequest extends NativeRequest {}
  Object.defineProperty(FirefoxRequest.prototype, "body", { get: () => undefined })
  globalThis.Request = FirefoxRequest
  try {
    const methods: string[] = []
    const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [ranked("https://provider", 1)] })
      methods.push(request.method)
      expect(await request.text()).toBe("")
      return new Response(null, { status: 200 })
    } })
    for (const method of ["GET", "HEAD"]) {
      expect((await routed("https://paid.invalid/resource", {
        functionality: f, method,
      })).status).toBe(200)
    }
    expect(methods).toEqual(["GET", "HEAD"])
  } finally {
    globalThis.Request = NativeRequest
  }
})

test("selects scores by functionality for each provider rather than array position", async () => {
  const otherScoring = { ...ingressScoring, variant: { ...ingressScoring.variant, tag: "other" } }
  const advertisement = ranked("https://a", 10)
  advertisement.providers[0].scores.unshift({ scoringFunctionality: otherScoring, score: 999 })
  advertisement.providers.push(ranked("https://b", 20).providers[0])
  const missingScore = ranked("https://missing", 100)
  missingScore.providers[0].scores = [{ scoringFunctionality: otherScoring, score: 100 }]
  const missingPrincipal = ranked("https://anonymous", 100)
  missingPrincipal.providers[0].principal = ""
  const providers = await discover({ providerScorings: [ingressScoring], indices: ["https://index"], fetch: async () => Response.json({ providerAdvertisements: [advertisement, missingScore, missingPrincipal] }) }, f)
  expect(providers.map(p => p.origin)).toEqual(["https://b", "https://a"])
  expect(providers[1].scores).toHaveLength(2)
})

test("requests multiple models and uses an available requested model", async () => {
  const unsupported = { ...ingressScoring, variant: { ...ingressScoring.variant, tag: "unsupported" } }
  const providers = await discover({ providerScorings: [unsupported, ingressScoring], indices: ["https://index"], fetch: async (_input, init) => {
    expect(JSON.parse(await new Response(init!.body).text()).providerScorings).toEqual([unsupported, ingressScoring])
    return Response.json({ providerAdvertisements: [ranked("https://a", 10), ranked("https://b", 20)] })
  } }, f)
  expect(providers.map(p => p.origin)).toEqual(["https://b", "https://a"])
})

test("local interceptor returns no match without sending an operation", async () => {
  let calls = 0
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async input => {
    calls++
    expect(new URL(input.toString()).hostname).toBe("index")
    return Response.json({ providerAdvertisements: [] })
  } })
  expect((await routed("https://paid.invalid/file", { functionality: f })).status).toBe(404)
  expect(calls).toBe(1)
})

test("ordinary requests bypass discovery and preserve input, options, and bodies", async () => {
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = []
  const routed = createRoutingFixture({ indices: [], providerScorings: [], fetch: async (input, init) => {
    calls.push({ input, init })
    return new Response("ordinary")
  } })
  const original = new Request("https://example.com/upload", { method: "POST", body: "unchanged" })
  expect(await (await routed(original)).text()).toBe("ordinary")
  expect(calls[0].input).toBe(original)
  expect(calls[0].init).toBeUndefined()
  expect(original.bodyUsed).toBe(false)
  const ordinaryInit = { method: "POST", body: "unbuffered" }
  await routed("https://example.com/upload", ordinaryInit)
  expect(calls[1].init).toBe(ordinaryInit)
  await routed("https://paid.invalid.example/path", { headers: { "x-operation": "kept" }, functionality: f })
  expect(calls[2].input).toBe("https://paid.invalid.example/path")
  expect(calls[2].init).toEqual({ headers: { "x-operation": "kept" } })
})

test("PAID requests without functionality fail before DNS or discovery", async () => {
  let calls = 0
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async () => { calls++; return new Response() } })
  await expect(routed("https://paid.invalid/file")).rejects.toThrow("require a functionality")
  expect(calls).toBe(0)
})

test("one interceptor routes multiple functionalities independently", async () => {
  const other: Functionality = { ...f, variant: { ...f.variant, name: "other" } }
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async (input, init) => {
    expect(init).not.toHaveProperty("functionality")
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") {
      const functionality = (await request.json()).functionality
      return Response.json({ providerAdvertisements: [ranked(functionality.variant.name === "other" ? "https://second" : "https://first", 1, functionality)] })
    }
    return new Response(new URL(request.url).origin)
  } })
  expect(await (await routed("https://paid.invalid/file", { functionality: f })).text()).toBe("https://first")
  expect(await (await routed("https://paid.invalid/file", { functionality: other })).text()).toBe("https://second")
})

test("the interceptor can replace global fetch without recursively routing discovery", async () => {
  const saved = globalThis.fetch
  const calls: string[] = []
  try {
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init)
      calls.push(request.url)
      if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [ranked("https://provider", 1)] })
      return new Response("ok")
    }) as typeof fetch
    const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring] })
    globalThis.fetch = routed as typeof fetch
    await routed("https://example.com/static")
    await routed("https://paid.invalid/file", { functionality: f })
    expect(calls).toEqual(["https://example.com/static", "https://index/index.v1.IndexService/SearchProvider", "https://provider/file"])
  } finally { globalThis.fetch = saved }
})


test("router rejects expired providers returned by an index even when they rank highest", async () => {
  const expired = ranked("https://expired", 999)
  expired.providers[0].expireTime = new Date(Date.now() - 1000).toISOString()
  const contacted: string[] = []
  let includeLive = true
  const routed = createRoutingFixture({ indices: ["https://index"], providerScorings: [ingressScoring], fetch: async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") {
      return Response.json({ providerAdvertisements: includeLive ? [expired, ranked("https://live", 1)] : [expired] })
    }
    contacted.push(new URL(request.url).origin)
    return new Response("live provider")
  } })
  expect(await (await routed("https://paid.invalid/file", { functionality: f })).text()).toBe("live provider")
  expect(contacted).toEqual(["https://live"])
  includeLive = false
  expect((await routed("https://paid.invalid/file", { functionality: f })).status).toBe(404)
  expect(contacted).toEqual(["https://live"])
})

test("router applies custom sorting after reusable validation and retries in its order", async () => {
  const attempts: string[] = []
  let rankedOrigins: string[] = []
  const expired = ranked("https://expired", 1000)
  expired.providers[0].expireTime = new Date(Date.now() - 1000).toISOString()
  const badOrigin = ranked("https://bad/path", 1000)
  const anonymous = ranked("https://anonymous", 1000)
  anonymous.providers[0].principal = ""
  const missingExpiry = { ...ranked("https://missing-expiry", 1000), providers: [{ ...ranked("https://missing-expiry", 1000).providers[0], expireTime: undefined }] }
  const routed = createRoutedFetch({
    indices: ["https://index"],
    providerRanker: { providerScorings: [ingressScoring], rank: providers => {
      rankedOrigins = providers.map(p => p.origin)
      return [...providers].sort((a, b) => b.origin.localeCompare(a.origin))
    } },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [expired, badOrigin, anonymous, missingExpiry, ranked("https://first", 100), ranked("https://second", 1), ranked("https://second", 2)] })
      attempts.push(request.url)
      return new Response("result", { status: attempts.length === 1 ? 503 : 200 })
    },
  })
  expect(await (await routed("https://paid.invalid/path?q=1", { functionality: f })).text()).toBe("result")
  expect(rankedOrigins).toEqual(["https://first", "https://second", "https://second"])
  expect(attempts).toEqual(["https://second/path?q=1", "https://first/path?q=1"])
})

test("router requires an explicitly selected ranking rule", async () => {
  const config = { indices: ["https://index"] } as RouterConfig
  expect(() => createRoutedFetch(config)).toThrow("providerRanker must be explicitly configured")
  await expect(discoverProviders(config, f)).rejects.toThrow("providerRanker must be explicitly configured")
})

test("router skips providers that expire while an earlier attempt runs, under a custom rule", async () => {
  const clock = Date.now
  let now = clock()
  const first = ranked("https://first", 1)
  const expiring = ranked("https://expiring", 1)
  expiring.providers[0].expireTime = new Date(now + 1000).toISOString()
  const last = ranked("https://last", 1)
  const attempts: string[] = []
  const routed = createRoutedFetch({
    indices: ["https://index"], providerRanker: { providerScorings: [], rank: providers => [...providers] },
    fetch: async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).hostname === "index") return Response.json({ providerAdvertisements: [first, expiring, last] })
      attempts.push(new URL(request.url).origin)
      if (attempts.length === 1) { now += 2000; return new Response(null, { status: 503 }) }
      return new Response("last")
    },
  })
  Date.now = () => now
  try {
    expect(await (await routed("https://paid.invalid/file", { functionality: f })).text()).toBe("last")
    expect(attempts).toEqual(["https://first", "https://last"])
  } finally { Date.now = clock }
})
