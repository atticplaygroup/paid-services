import { describe, expect, it } from "bun:test"
import { createOutproxyFetch } from "./outproxy.js"

describe("outproxy middleware", () => {
  it("proxied requests preserve caller headers unchanged", async () => {
    const seen: Headers[] = []
    const proxies: unknown[] = []
    const fetchFn = createOutproxyFetch("http://outproxy.invalid")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      proxies.push((init as RequestInit & { proxy?: string })?.proxy)
      return new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } })
    }) as typeof fetch
    try {
      await fetchFn("http://kvstore.invalid/example", {
        method: "POST",
        headers: { "x-user-id": "alice", "x-request-id": "internal", "x-external-request-id": "external" },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(seen).toHaveLength(1)
    expect(proxies).toEqual(["http://outproxy.invalid"])
    expect(seen[0].has("authorization")).toBe(false)
    expect(seen[0].get("x-user-id")).toBe("alice")
    expect(seen[0].get("x-request-id")).toBe("internal")
    expect(seen[0].get("x-external-request-id")).toBe("external")
  })
})
