import { test, expect, spyOn } from "bun:test"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { pappId, proposerPrincipal, type PappManifest } from "../../papp-sdk/src/lib.ts"
import { signManifest } from "../../../proposer/app-packer/papp.ts"
import { releaseTag, signReleaseVariant } from "../../papp-sdk/src/variant.ts"
import { packFiles } from "../../ipfs/src/pack.ts"
import * as configStore from "./config-store.ts"

test("worker initializes and loads updates without a gateway manifest endpoint", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const proposer = await proposerPrincipal(await crypto.subtle.exportKey("jwk", key.publicKey))
  const id = await pappId("worker-test", proposer), origin = `https://${id}.apps.test`
  const blocks = new Map<string, Uint8Array>()
  let advertisement: any, anchor: any
  async function publish(version: number, corrupt = false) {
    const packed = await packFiles({ "index.html": new TextEncoder().encode(`<h1>Release ${version}</h1>`) })
    for (const [cid, bytes] of packed.blocks) blocks.set(cid, bytes)
    const manifest = await signManifest(key, { name: "worker-test", proposer, version, webpage: `ipfs://${packed.root}`, functionality: { behavior: { name: "papp-render", maintainer: proposer, tag: "v1" }, variant: { name: id, maintainer: proposer, tag: releaseTag(new Date(Date.UTC(2026, 10, version))) } } })
    if (corrupt) manifest.signature = manifest.signature.slice(0, -4) + "AAAA"
    const bytes = new TextEncoder().encode(JSON.stringify(manifest)), cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
    blocks.set(cid, bytes)
    anchor = await signReleaseVariant(key, manifest.functionality, cid)
    advertisement = { functionality: { ...manifest.functionality, variant: { ...manifest.functionality.variant } }, providers: [{ origin: "https://storage.test", principal: proposer, expireTime: new Date(Date.now() + 3600000).toISOString() }] }
  }
  await publish(1)
  const calls: string[] = [], upstreams: string[] = [], handlers = new Map<string, (event: any) => void>()
  const transport: { objects: null; blockGateway: string | null; delegatedRoutingUrl: null } = { objects: null, blockGateway: null, delegatedRoutingUrl: null }
  const oldSelf = (globalThis as any).self
  ;(globalThis as any).self = { location: new URL(origin), addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler) } }
  const config = spyOn(configStore, "workerConfig").mockResolvedValue({ server: "https://user.test", profile: "saved-profile", objects: { variant: { name: "removed-release" } }, blockGateway: "https://removed-gateway.test", delegatedRoutingUrl: "https://removed-router.test" })
  const network = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    calls.push(request.url)
    // A cold worker must never call its gateway for identity or manifest bytes.
    if (url.origin === origin) {
      if (url.pathname === "/__papp/gateway-config") return Response.json(transport)
      throw new Error("gateway has no per-app state")
    }
    expect(url.origin).toBe("https://user.test")
    if (url.pathname === "/config") return Response.json({ indices: ["https://index.test"], providerScorings: [] })
    if (url.pathname === "/token") return Response.json({ accessToken: "fixture-proof" })
    if (url.pathname === "/outproxy") {
      const upstream = await request.json()
      upstreams.push(upstream.url)
      if (upstream.url.startsWith("https://kubo.test/ipfs/")) {
        const cid = new URL(upstream.url).pathname.split("/").pop()!
        return blocks.has(cid) ? new Response(blocks.get(cid)) : new Response(null, { status: 404 })
      }
      expect(upstream.headers).toContainEqual(["authorization", "Bearer fixture-proof"])
      if (upstream.url === "https://index.test/sql") {
        expect(request.headers.get("x-paid-app")).toBe(id)
        return Response.json({ columns: ["advertisement"], rows: [[advertisement]] })
      }
      if (upstream.url.endsWith("/GetProtectedValueAnchor")) return Response.json({ anchor })
      if (upstream.url.startsWith("https://storage.test/applications/user/public/value/")) {
        expect(request.headers.get("x-paid-proposer")).toBe(proposer)
        const cid = upstream.url.split("/").pop()!
        return blocks.has(cid) ? new Response(blocks.get(cid)) : new Response(null, { status: 404 })
      }
    }
    throw new Error("Unexpected request: " + request.url)
  })
  async function request(path = "/papp-manifest", navigation = false) {
    let response: Promise<Response> | undefined
    const request = new Request(origin + path)
    if (navigation) Object.defineProperty(request, "mode", { value: "navigate" })
    handlers.get("fetch")!({ request, respondWith(value: Promise<Response>) { response = value } })
    if (!response) throw new Error("worker did not intercept manifest request")
    return response
  }
  try {
    await import("./sw.ts")
    expect(((await (await request()).json()) as PappManifest).version).toBe(1)
    expect(await (await request("/index.html")).text()).toBe("<h1>Release 1</h1>")
    await publish(2)
    expect(((await (await request()).json()) as PappManifest).version).toBe(2)
    expect(await (await request("/index.html")).text()).toBe("<h1>Release 2</h1>")
    // A reload must see a changed gateway transport without rewriting the
    // user's saved profile or requiring another trip through configuration.
    transport.blockGateway = "https://kubo.test"
    expect(await (await request("/index.html", true)).text()).toBe("<h1>Release 2</h1>")
    expect(upstreams.some(url => url.startsWith("https://kubo.test/ipfs/"))).toBe(true)
    transport.blockGateway = null
    const before = upstreams.filter(url => url.startsWith("https://storage.test/applications/user/public/value/")).length
    expect(await (await request("/index.html", true)).text()).toBe("<h1>Release 2</h1>")
    expect(upstreams.filter(url => url.startsWith("https://storage.test/applications/user/public/value/")).length).toBeGreaterThan(before)
    await publish(3, true)
    const invalid = await request()
    expect(invalid.status).toBe(502)
    expect(await invalid.text()).toContain("No valid pApp release")
    expect(calls.every(url => !url.startsWith(origin) || url === origin + "/__papp/gateway-config")).toBe(true)
    expect(calls.some(url => url.includes("removed-"))).toBe(false)
  } finally {
    network.mockRestore(); config.mockRestore()
    if (oldSelf === undefined) delete (globalThis as any).self; else (globalThis as any).self = oldSelf
  }
}, 30000)
