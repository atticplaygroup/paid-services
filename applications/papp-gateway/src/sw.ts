/// <reference lib="webworker" />
import { createPaidVerifiedFetch } from "../../ipfs/src/lib.ts"
import { userConnection } from "../../papp-sdk/src/transport.ts"
import { budget, rendering, type Functionality } from "../../papp-sdk/src/lib.ts"
import { loadLatestRelease as loadReleaseFromIndex } from "./releases.ts"
import { workerConfig } from "./config-store.ts"
declare const self: ServiceWorkerGlobalScope
const network = globalThis.fetch.bind(globalThis)
const cacheName = "paid-worker-config-v1"
const configUrl = new URL("/__paid_worker_config", self.location.origin).href
async function config() {
  const saved = await workerConfig()
  if (saved) return saved
  // Preserve the profile used by earlier workers when upgrading their store.
  const legacy = await (await caches.open(cacheName)).match(configUrl)
  if (!legacy) throw new Error("Configure a user server before loading the pApp")
  return workerConfig(await legacy.json())
}
let initialization: Promise<any> | undefined
let transportKey: string | undefined
async function initializeApp(refreshTransport = false) {
  let transport: any
  if (refreshTransport || !initialization) {
    const response = await network(new URL("/__papp/gateway-config", self.location.origin), { cache: "no-store" })
    if (!response.ok) throw new Error(`Gateway transport configuration: ${response.status}`)
    const current = await response.json()
    transport = { objects: current.objects ?? null, blockGateway: current.blockGateway ?? null, delegatedRoutingUrl: current.delegatedRoutingUrl ?? null }
    const key = JSON.stringify(transport)
    if (key !== transportKey) { initialization = undefined; transportKey = key }
  }
  if (!initialization) initialization = (async () => {
    // Keep the user's server/profile, but ignore legacy transport overrides.
    const c = { ...await config(), ...transport }
    const id = self.location.hostname.split(".")[0]
    // Before loading the release, only the app ID is known; its proposer cannot
    // be recovered from that hash. Use a separate profile for bootstrap reads.
    const bootstrapClient = userConnection(c.server, { app: id, proposer: id, profile: c.profile + ":discovery" }, network)
    const userConfig = await (await bootstrapClient.call("/config")).json()
    async function loadLatestRelease(target: string) {
      return loadReleaseFromIndex(target, userConfig.indices, bootstrapClient.authenticated, (origin, path, proposer, init) => {
        const manifestClient = userConnection(c.server, { app: id, proposer, profile: c.profile + ":release:" + proposer }, network)
        return manifestClient.authenticated(origin + path, init)
      })
    }
    const selected = await loadLatestRelease(id)
    const userClient = userConnection(c.server, { app: id, proposer: selected.manifest.proposer, profile: c.profile }, network)
    const paid = await userClient.routed()
    const brokers = new Map<string, ReturnType<typeof createPaidVerifiedFetch>>()
    function ipfsFor(functionality: Functionality) {
      const objects = c.objects ?? functionality
      const key = JSON.stringify(objects)
      let broker = brokers.get(key)
      if (!broker) {
        broker = createPaidVerifiedFetch({ fetch: paid, objects, indices: userConfig.indices, indexFetch: userClient.authenticated, delegatedRoutingUrl: c.delegatedRoutingUrl, blockGateway: c.blockGateway, gatewayFetch: userClient.outproxy })
        brokers.set(key, broker)
        broker.catch(() => brokers.delete(key))
      }
      return broker
    }
    return { userClient, paid, userConfig, ipfsFor, id, loadLatestRelease }
  })().catch(error => { initialization = undefined; throw error })
  return initialization
}
async function loadLatestManifest(id: string) {
  return (await (await initializeApp()).loadLatestRelease(id)).manifest
}
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()))
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url)
  // Keep the configuration return page controlled; Firefox can otherwise wait
  // indefinitely for controllerchange after a network-only navigation.
  if (request.mode === "navigate" && url.searchParams.has("__paid_config")) { event.respondWith(network(request)); return }
  if (url.origin === self.location.origin && ["/sw.js", "/bootstrap.js", "/healthz", "/__papp/gateway-config"].includes(url.pathname)) return
  if (url.origin === self.location.origin && url.pathname === "/__papp/config") {
    event.respondWith((async () => {
      if (request.method === "POST") {
        const c = await request.json()
        if (!c.server || !["http:", "https:"].includes(new URL(c.server).protocol)) throw new Error("Invalid user server address")
        const old = await config().catch(() => ({}))
        await workerConfig({ ...old, ...c, profile: old.profile ?? crypto.randomUUID() })
        initialization = undefined
      }
      try { await config(); return Response.json({ configured: true }) } catch { return new Response("No user server configured", { status: 404 }) }
    })()); return
  }
  if (url.hostname === "paid.invalid" || url.origin === self.location.origin || ["ipfs:", "ipns:"].includes(url.protocol)) event.respondWith(handle(request).catch(error => new Response(`PAID: ${error.message}`, { status: 502, headers: { "content-type": "text/plain" } })))
})
async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  if (request.mode === "navigate" && !await config().catch(() => null)) return network(request)
  const c = await initializeApp(request.mode === "navigate")
  if (url.origin === self.location.origin && url.pathname === "/papp-manifest") return Response.json(await loadLatestManifest(url.searchParams.get("id") ?? c.id))
  if (url.hostname === "paid.invalid") {
    const f = JSON.parse(request.headers.get("x-paid-functionality") ?? "null")
    if (!f) throw new Error("Missing X-PAID-Functionality")
    if (f.behavior?.name === budget.behavior.name) return c.userClient.call("/budget")
    if (f.behavior?.name === rendering.behavior.name) {
      const id = url.searchParams.get("id") ?? ""
      await loadLatestManifest(id)
      const target = new URL(self.location.origin); target.hostname = id + "." + self.location.hostname.split(".").slice(1).join(".")
      return Response.json({ url: target.href })
    }
    const b = await (await c.userClient.call("/budget")).json()
    if (b.remaining === "0") return new Response("Daily budget exhausted", { status: 402 })
    return c.paid(request)
  }
  const selected = await c.loadLatestRelease(c.id)
  const ipfs = await c.ipfsFor(selected.functionality)
  if (["ipfs:", "ipns:"].includes(url.protocol)) return ipfs.fetch(url.href)
  if (/^\/(ipfs|ipns)\//.test(url.pathname)) {
    const [, protocol, name, ...path] = url.pathname.split("/")
    return ipfs.fetch(`${protocol}://${name}/${path.join("/")}${url.search}`, { signal: request.signal })
  }
  const release = selected.manifest
  let path = url.pathname
  if (request.mode === "navigate" || path === "/") path = "/index.html"
  const root = release.webpage.replace(/\/$/, "")
  const response = await ipfs.fetch(root + path, { signal: request.signal })
  // Force complete verification before a browser can execute the document.
  const bytes = await response.arrayBuffer()
  const headers = new Headers(response.headers)
  const types: Record<string,string> = { js: "text/javascript", css: "text/css", html: "text/html", json: "application/json", png: "image/png", svg: "image/svg+xml" }
  headers.set("content-type", types[path.split(".").pop()!] ?? headers.get("content-type") ?? "application/octet-stream")
  headers.set("x-paid-release", String(release.version))
  headers.set("cache-control", "no-store")
  return new Response(bytes, { status: response.status, headers })
}
