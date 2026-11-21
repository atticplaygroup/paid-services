import { test, expect } from "bun:test"
import { packFiles } from "./pack.ts"
import { createPaidVerifiedFetch, paidBlockBroker, blockFailureDetails } from "./lib.ts"
test("UnixFS directories and chunked files round-trip through the PAID broker", async () => {
  const content = crypto.getRandomValues(new Uint8Array(65000))
  const packed = await packFiles({ "index.html": new TextEncoder().encode("<h1>verified</h1>"), "nested/file.bin": content })
  const calls: string[] = []
  const client = await createPaidVerifiedFetch({ objects: {} as any, fetch: (async input => { const u = new URL(String(input)); calls.push(u.pathname); const block = packed.blocks.get(u.pathname.split("/").pop()!); return new Response(block, { status: block ? 200 : 404 }) }) as typeof fetch })
  try {
    expect(await (await client.fetch(`ipfs://${packed.root}/index.html`)).text()).toBe("<h1>verified</h1>")
    expect(new Uint8Array(await (await client.fetch(`ipfs://${packed.root}/nested/file.bin`)).arrayBuffer())).toEqual(content)
    expect(calls.length).toBeGreaterThan(2)
  } finally { await client.stop() }
})
test("broker rejects a corrupt block before returning it to Helia", async () => {
  const p = await packFiles({ "index.html": new TextEncoder().encode("safe") })
  const broker = paidBlockBroker({ objects: {} as any, fetch: (async () => new Response("attacker")) as typeof fetch })
  try {
    await broker.retrieve!(p.root)
    throw new Error("corrupt block accepted")
  } catch (error) {
    expect(blockFailureDetails(error)).toContain("integrity mismatch")
  }
})

test("file loading exposes failed index lookup and empty provider discovery", async () => {
  const packed = await packFiles({ "index.html": new TextEncoder().encode("unavailable") })
  const client = await createPaidVerifiedFetch({ objects: { variant: { name: "release-files" } }, indices: ["https://down.test", "https://empty.test"], fetch,
    indexFetch: (async input => String(input).startsWith("https://down.test") ? new Response(null, { status: 503 }) : Response.json({ columns: ["advertisement"], rows: [] })) as typeof fetch })
  try {
    const response = await client.fetch(`ipfs://${packed.root}/index.html`)
    expect(response.status).toBe(504)
    const details = await response.text()
    expect(details).toContain("No matching unexpired file providers")
    expect(details).toContain("https://down.test/sql returned HTTP 503")
  } finally { await client.stop() }
})

test("file loading exposes each provider's HTTP failure", async () => {
  const packed = await packFiles({ "index.html": new TextEncoder().encode("missing") })
  const client = await createPaidVerifiedFetch({ objects: {} as any, blockGateway: "https://files.test", fetch: (async () => new Response(null, { status: 404 })) as typeof fetch })
  try {
    const response = await client.fetch(`ipfs://${packed.root}/index.html`)
    expect(response.status).toBe(504)
    expect(await response.text()).toContain(`Block ${packed.root} from https://files.test failed; HTTP 404`)
  } finally { await client.stop() }
})

test("failed downloads remain diagnosable and recover on the same client", async () => {
  const packed = await packFiles({ "index.html": new TextEncoder().encode("recovered") })
  let mode = "network"
  const client = await createPaidVerifiedFetch({ objects: {} as any, blockGateway: "https://files.test", fetch: (async input => {
    if (mode === "network") throw new TypeError("connection refused")
    if (mode === "corrupt") return new Response("corrupt")
    return new Response(packed.blocks.get(new URL(String(input)).pathname.split("/").pop()!))
  }) as typeof fetch })
  try {
    for (const [next, reason] of [["network", "connection refused"], ["corrupt", "integrity mismatch"]]) {
      mode = next
      const response = await client.fetch(`ipfs://${packed.root}/index.html`)
      expect(response.status).toBe(504)
      expect(await response.text()).toContain(reason)
    }
    mode = "healthy"
    const response = await client.fetch(`ipfs://${packed.root}/index.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("recovered")
  } finally { await client.stop() }
})
test("Helia skips an unreachable index, discovers providers through SQL and reads S3 directly", async () => {
  const packed = await packFiles({ "index.html": new TextEncoder().encode("index-backed") })
  const functionality = { variant: { name: "storage" } }
  const calls: string[] = []
  const client = await createPaidVerifiedFetch({ objects: functionality, indices: ["http://unreachable.test", "http://index.test"], fetch, indexFetch: (async (input, init) => {
    const url = String(input); calls.push(url)
    if (url === "http://unreachable.test/sql") throw new TypeError("fetch failed")
    if (url.endsWith("/sql")) return Response.json({ columns: ["advertisement"], rows: [[JSON.stringify({ functionality, providers: [{ origin: "http://storage.test", principal: "bahi5maysedugkwklvh42i2f73axyj6qntw6mdobxkzcqqjmq7imheuk7fvflu", expireTime: "2030-01-01T00:00:00Z" }] })]] })
    return new Response(packed.blocks.get(new URL(url).pathname.split("/").pop()!))
  }) as typeof fetch })
  try {
    expect(await (await client.fetch(`ipfs://${packed.root}/index.html`)).text()).toBe("index-backed")
    expect(calls.some(c => c === "http://unreachable.test/sql")).toBe(true)
    expect(calls.some(c => c === "http://index.test/sql")).toBe(true)
    expect(calls.some(c => c.startsWith("http://storage.test/applications/user/public/value/"))).toBe(true)
  } finally { await client.stop() }
})
