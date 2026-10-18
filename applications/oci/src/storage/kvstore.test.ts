import { describe, expect, it } from "bun:test"
import { createProxiedFetch, KvstoreClient, principalFromJwk } from "./kvstore.js"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import * as pb from "../proto/gen/es/kvstore/v1/kvstore_pb.js"
import { createOciApp } from "../server.js"
import type { MeterClient } from "../meter.js"
import type { Anchor } from "../proto/gen/es/kvstore/v1/kvstore_pb.js"

async function keypair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>
}

async function publicJwk(pair: CryptoKeyPair): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  delete jwk.key_ops
  delete jwk.ext
  return JSON.stringify(jwk)
}

describe("KvstoreClient anchors", () => {
  it("proxied requests preserve caller headers unchanged", async () => {
    const seen: Headers[] = []
    const fetchFn = createProxiedFetch("http://outproxy.invalid")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
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
    expect(seen[0].get("x-user-id")).toBe("alice")
    expect(seen[0].get("x-request-id")).toBe("internal")
    expect(seen[0].get("x-external-request-id")).toBe("external")
  })

  it("signs and verifies a manifest tag anchor", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    const body = new TextEncoder().encode("feature3-manifest")
    await client.putManifestTag("alice/testrepo", "latest", body, 1)
    const storedAnchor = (client as any).lastAnchor as Anchor
    const expectedOwner = await principalFromJwk(await crypto.subtle.exportKey("jwk", pair.publicKey))
    const anchor = { ...storedAnchor, owner: expectedOwner }
    expect(storedAnchor.owner).toBe(expectedOwner)
    expect(anchor.key).toBe("oci/manifests/alice/testrepo/latest")
    expect(anchor.revision).toBe(1n)
    expect(anchor.ownerJwk).toBe(await publicJwk(pair))
    await (client as any).verifyAnchor(anchor)
  })

  it("rejects a tampered anchor payload", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    const body = new TextEncoder().encode("feature3-manifest")
    await client.putManifestTag("alice/testrepo", "latest", body, 1)
    const anchor = { ...(client as any).lastAnchor as Anchor, cid: "bafkreig7f4xujwi5nzjncvau2wpqjmqcnkts7dr5lpsgm3tqe2mvrqphjm" }
    await expect((client as any).verifyAnchor(anchor)).rejects.toThrow("anchor payload mismatch")
  })

  it("signs and verifies a tag-list anchor", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    await client.putTagList("alice/testrepo", ["latest"])
    const anchor = (client as any).lastAnchor as Anchor
    expect(anchor.key).toBe("oci/tags/alice/testrepo")
    await (client as any).verifyAnchor(anchor)
  })
})


it("serves publisher tags through a reader with a different payment identity", async () => {
  const anchors = new Map<string, Anchor>()
  const blobs = new Map<string, Uint8Array>()
  const respond = (schema: any, value: any) => new Response(toBinary(schema, create(schema, value)), {
    headers: { "content-type": "application/proto" },
  })
  const storageFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = String(input).split("/").pop()
    const body = new Uint8Array(await new Response(init?.body).arrayBuffer())
    switch (method) {
      case "CreateCASValue": {
        const req = fromBinary(pb.CreateCASValueRequestSchema, body)
        blobs.set(req.key, req.value)
        return respond(pb.CreateCASValueResponseSchema, {})
      }
      case "GetCASValue": {
        const req = fromBinary(pb.GetCASValueRequestSchema, body)
        return respond(pb.GetCASValueResponseSchema, { value: blobs.get(req.key) })
      }
      case "CreateProtectedValueAnchor": {
        const req = fromBinary(pb.CreateProtectedValueAnchorRequestSchema, body)
        const anchor = req.anchor!
        anchors.set(`${anchor.owner}:${anchor.key}`, anchor)
        return respond(pb.CreateProtectedValueAnchorResponseSchema, {})
      }
      case "GetProtectedValueAnchor": {
        const req = fromBinary(pb.GetProtectedValueAnchorRequestSchema, body)
        const anchor = anchors.get(`${req.owner}:${req.key}`)
        if (!anchor) return new Response(JSON.stringify({ code: "not_found", message: "anchor not found" }), {
          status: 404, headers: { "content-type": "application/json" },
        })
        return respond(pb.GetProtectedValueAnchorResponseSchema, { anchor })
      }
      default: throw new Error(`unexpected storage method: ${method}`)
    }
  }
  const publisherKeys = await keypair()
  const readerKeys = await keypair()
  const owner = await principalFromJwk(await crypto.subtle.exportKey("jwk", publisherKeys.publicKey))
  const readerOwner = await principalFromJwk(await crypto.subtle.exportKey("jwk", readerKeys.publicKey))
  expect(readerOwner).not.toBe(owner)
  const publisher = new KvstoreClient("http://storage.invalid", publisherKeys, undefined, storageFetch)
  const reader = new KvstoreClient("http://storage.invalid", readerKeys, undefined, storageFetch)
  const meter = { reportUsage: async () => true } as unknown as MeterClient
  const writerApp = createOciApp({ kvstore: publisher, meter })
  const readerApp = createOciApp({ kvstore: reader, meter, readOnly: true })
  const name = `${owner}/image`
  const manifest = { schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] }
  const put = await writerApp.request(`/v2/${name}/manifests/latest`, {
    method: "PUT", headers: { "x-user-id": owner, "x-request-id": "publish" }, body: JSON.stringify(manifest),
  })
  expect(put.status).toBe(201)
  const get = await readerApp.request(`/v2/${name}/manifests/latest`)
  expect(get.status).toBe(200)
  expect(await get.json()).toEqual(manifest)
  const tags = await readerApp.request(`/v2/${name}/tags/list`)
  expect(await tags.json()).toEqual({ name, tags: ["latest"] })
  expect((await readerApp.request(`/v2/${readerOwner}/image/manifests/latest`)).status).toBe(404)
  expect(await (await readerApp.request(`/v2/${readerOwner}/image/tags/list`)).json()).toEqual({
    name: `${readerOwner}/image`, tags: [],
  })

  // A valid signature for another namespace must not satisfy this lookup.
  const manifestKey = `oci/manifests/${name}/latest`
  const tagKey = `oci/tags/${name}`
  const manifestAnchor = anchors.get(`${owner}:${manifestKey}`)!
  const tagAnchor = anchors.get(`${owner}:${tagKey}`)!
  anchors.set(`${owner}:${manifestKey}`, tagAnchor)
  expect((await readerApp.request(`/v2/${name}/manifests/latest`)).status).toBe(404)
  anchors.set(`${owner}:${manifestKey}`, manifestAnchor)
  anchors.set(`${owner}:${tagKey}`, manifestAnchor)
  expect(await (await readerApp.request(`/v2/${name}/tags/list`)).json()).toEqual({ name, tags: [] })
})
