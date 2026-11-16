import { expect, test } from "bun:test"
import { createPaidClient, type Functionality } from "./lib.ts"

const functionality: Functionality = { behavior: { name: "read", maintainer: "test", tag: "v1" }, variant: { name: "data", maintainer: "test", tag: "v1" } }
const scoring: Functionality = { ...functionality, variant: { name: "score", maintainer: "test", tag: "v1" } }

test("SDK pays for discovery, binds read proofs to providers, and preserves conventional authorization", async () => {
  const proofs: string[] = [], operations: string[] = []
  const client = createPaidClient({ indices: ["https://index"], providerScorings: [scoring] }, {
    async getAccessToken(request) { proofs.push(`${request.method} ${request.url}`); return "paid-proof" },
  }, (async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === "index") {
      expect(request.headers.get("authorization")).toBe("Bearer paid-proof")
      return Response.json({ providerAdvertisements: [{ functionality, signature: "fixture", providers: [
        { origin: "https://impostor", principal: "other", expireTime: new Date(Date.now() + 60000).toISOString(), scores: [{ scoringFunctionality: scoring, score: 20 }] },
        { origin: "https://provider", principal: "proposer", expireTime: new Date(Date.now() + 60000).toISOString(), scores: [{ scoringFunctionality: scoring, score: 10 }] },
      ] }] })
    }
    operations.push(request.url)
    expect(request.headers.get("authorization")).toBe(request.method === "PUT" ? "Bearer oidc" : "Bearer paid-proof")
    expect(await request.text()).toBe("你好 payload")
    return new Response("ok")
  }) as typeof fetch)
  const acceptProvider = (provider: { principal: string }) => provider.principal === "proposer"
  await client.fetch("https://paid.invalid/sql?limit=1", { functionality, acceptProvider, method: "POST", body: "你好 payload", routerRetry: true })
  await client.conventionalFetch("https://paid.invalid/article", { functionality, acceptProvider, method: "PUT", headers: { authorization: "Bearer oidc" }, body: "你好 payload", routerRetry: false })
  expect(operations).toEqual(["https://provider/sql?limit=1", "https://provider/article"])
  expect(proofs).toContain("POST https://provider/sql?limit=1")
  expect(proofs.some(value => value.includes("paid.invalid") || value.includes("impostor") || value.startsWith("PUT"))).toBe(false)
})
