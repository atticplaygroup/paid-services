import { describe, expect, it } from "bun:test"
import { KvstoreClient } from "./kvstore.js"
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
  it("signs and verifies a manifest tag anchor", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    const body = new TextEncoder().encode("feature3-manifest")
    await client.putManifestTag("alice/testrepo", "latest", "principal", body, 1)
    const anchor = (client as any).lastAnchor as Anchor
    expect(anchor.owner).toBe("principal")
    expect(anchor.key).toBe("oci/manifests/alice/testrepo/latest")
    expect(anchor.revision).toBe(1n)
    expect(anchor.ownerJwk).toBe(await publicJwk(pair))
    await (client as any).verifyAnchor(anchor)
  })

  it("rejects a tampered anchor payload", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    const body = new TextEncoder().encode("feature3-manifest")
    await client.putManifestTag("alice/testrepo", "latest", "principal", body, 1)
    const anchor = { ...(client as any).lastAnchor as Anchor, cid: "bafkreig7f4xujwi5nzjncvau2wpqjmqcnkts7dr5lpsgm3tqe2mvrqphjm" }
    await expect((client as any).verifyAnchor(anchor)).rejects.toThrow("anchor payload mismatch")
  })

  it("signs and verifies a tag-list anchor", async () => {
    const pair = await keypair()
    const client = new KvstoreClient("http://kvstore.invalid", pair, undefined, async () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "application/proto" } }))
    await client.putTagList("alice/testrepo", ["latest"], "principal")
    const anchor = (client as any).lastAnchor as Anchor
    expect(anchor.key).toBe("oci/tags/alice/testrepo")
    await (client as any).verifyAnchor(anchor)
  })
})
