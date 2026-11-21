import { createPaidVerifiedFetch } from "./lib.ts"
import { paidIndexRouting } from "./routing.ts"
import { createAuthenticatedFetch } from "../../client-auth/src/lib.ts"
import { userConnection } from "../../papp-sdk/src/transport.ts"
import { createRoutedFetch, createAverageScoreRanker } from "../../router/src/lib.ts"
// Authentication can use a user server or a local client key; otherwise requests use plain fetch.
const config = JSON.parse(await Bun.file(process.env.IPFS_CONFIG_FILE ?? "ipfs-config.json").text())
let authenticated = fetch
if (config.userServer) authenticated = userConnection(config.userServer, config.identity).authenticated
else if (process.env.IPFS_CLIENT_KEY_FILE) {
  const jwk = await Bun.file(process.env.IPFS_CLIENT_KEY_FILE).json()
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  authenticated = createAuthenticatedFetch({ privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]) })
}
const routed = createRoutedFetch({ indices: config.indices, providerRanker: createAverageScoreRanker({ providerScorings: config.providerScorings ?? [] }), fetch: authenticated })
const ipfs = await createPaidVerifiedFetch({ ...config, fetch: routed as typeof fetch, indexFetch: authenticated })
const router = paidIndexRouting({ indices: config.indices, functionality: config.objects, fetch: authenticated })
Bun.serve({ hostname: "0.0.0.0", port: Number(process.env.PORT ?? 3005), async fetch(request) {
  try {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") return Response.json({ ok: true })
    if (url.pathname.startsWith("/ipfs/") || url.pathname.startsWith("/ipns/")) {
      const [, protocol, name, ...path] = url.pathname.split("/")
      const response = await ipfs.fetch(`${protocol}://${name}/${path.join("/")}${url.search}`, { signal: request.signal })
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
    }
    if (url.pathname.startsWith("/routing/v1/providers/")) {
      const { CID } = await import("multiformats/cid")
      const records = []
      for await (const provider of router.findProviders!(CID.parse(url.pathname.split("/").pop()!))) records.push({ Schema: "peer", ID: provider.id.toString(), Addrs: [], Protocols: ["transport-paid-s3"], Origin: (provider as any).origin })
      return new Response(records.map(r => JSON.stringify(r)).join("\n"), { headers: { "content-type": "application/x-ndjson" } })
    }
    return new Response("Use /ipfs/<cid>/<path>, /ipns/<name>/<path>, or /routing/v1/providers/<cid>", { status: 404 })
  } catch (error) { return new Response((error as Error).message, { status: 502 }) }
} })
