import { test, expect } from "bun:test"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { pappId, verifyManifest, proposerPrincipal, type PappManifest } from "../../papp-sdk/src/lib.ts"
import { signManifest, publishManifest } from "../../../proposer/app-packer/papp.ts"
import { releaseTag, signReleaseVariant, variantKey } from "../../papp-sdk/src/variant.ts"
import { loadLatestRelease } from "./releases.ts"
import { createGateway } from "./server.ts"

async function fixture() {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const proposer = await proposerPrincipal(await crypto.subtle.exportKey("jwk", key.publicKey))
  const id = await pappId("test", proposer)
  const manifest = await signManifest(key, { name: "test", proposer, version: 1, webpage: "ipfs://bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq", functionality: { behavior: { name: "papp-render", maintainer: proposer, tag: "v1" }, variant: { name: id, maintainer: proposer, tag: releaseTag(new Date("2026-11-01T00:00:00Z")) } } })
  return { key, proposer, id, manifest }
}
async function record(manifest: PappManifest, key: CryptoKeyPair) {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
  const anchor = await signReleaseVariant(key, manifest.functionality, cid)
  return { bytes, cid, anchor, ad: { functionality: { ...manifest.functionality, variant: { ...manifest.functionality.variant } }, providers: [{ origin: "https://storage.test", principal: manifest.proposer, expireTime: new Date(Date.now() + 60000).toISOString() }] } }
}
function indexFetch(id: string, ads: any[]) {
  return (async (url, init) => {
    expect(String(url)).toBe("https://index.test/sql")
    const query = JSON.parse(String(init?.body))
    expect(query.sql).toContain("JSON_EXTRACT")
    expect(query.sql).toContain("$.functionality.variant.tag")
    expect(query.sql).not.toContain("ingress_time")
    expect(query.parameters).toEqual([id, 100])
    return Response.json({ columns: ["advertisement"], rows: ads.map(ad => [JSON.stringify(ad)]) })
  }) as typeof fetch
}
test("publish and load a signed release entirely through index and storage", async () => {
  const { id, manifest, key } = await fixture()
  expect(await verifyManifest(manifest, id)).toEqual(manifest)
  await expect(verifyManifest({ ...manifest, version: 2 }, id)).rejects.toThrow()
  await expect(verifyManifest(manifest, await pappId("another", manifest.proposer))).rejects.toThrow("identity mismatch")
  const entry = await record(manifest, key)
  const publication = await publishManifest(manifest, "https://storage.test", (async (url, init) => {
    if (String(url).endsWith("/CreateProtectedValueAnchor")) {
      const { anchor } = JSON.parse(String(init?.body))
      expect(anchor.cid).toBe(entry.cid)
      expect(anchor.key).toBe(variantKey(manifest.functionality))
      return new Response()
    }
    expect(String(url)).toBe("https://storage.test/kvstore.v1.MeteredStorageService/CreateCASValue")
    const body = JSON.parse(String(init?.body))
    expect(body.key).toBe(entry.cid)
    expect(body.codec).toBe("CODEC_RAW")
    expect(Buffer.from(body.value, "base64")).toEqual(Buffer.from(entry.bytes))
    return new Response()
  }) as typeof fetch, key)
  expect(publication.functionality).toEqual(entry.ad.functionality)
  const result = await loadLatestRelease(id, ["https://index.test"], indexFetch(id, [entry.ad]), async (origin, path, proposer) => {
    expect(origin).toBe("https://storage.test"); expect(proposer).toBe(manifest.proposer)
    if (path.endsWith("/GetProtectedValueAnchor")) return Response.json({ anchor: entry.anchor })
    expect(path).toBe(`/applications/user/public/value/${entry.cid}`)
    return new Response(entry.bytes)
  })
  expect(result.manifest).toEqual(manifest)
})
test("reject altered bytes, invalid signatures, wrong identities and mismatched functionality", async () => {
  const { id, manifest, key } = await fixture()
  const valid = await record(manifest, key)
  const invalidSignature = await record({ ...manifest, signature: manifest.signature.slice(0, -4) + "AAAA" }, key)
  const otherFixture = await fixture()
  const other = await record(otherFixture.manifest, otherFixture.key)
  const wrongIdentity = { ...other.ad, functionality: { ...other.ad.functionality, variant: { ...other.ad.functionality.variant, name: id } } }
  const wrongFunctionality = { ...valid.ad, functionality: { ...valid.ad.functionality, behavior: { ...valid.ad.functionality.behavior, tag: "wrong" } } }
  for (const [ad, bytes, anchor] of [[valid.ad, new TextEncoder().encode("corrupt"), valid.anchor], [invalidSignature.ad, invalidSignature.bytes, invalidSignature.anchor], [wrongIdentity, other.bytes, other.anchor], [wrongFunctionality, valid.bytes, valid.anchor]] as const) {
    await expect(loadLatestRelease(id, ["https://index.test"], indexFetch(id, [ad]), async (_origin, path) => path.endsWith("/GetProtectedValueAnchor") ? Response.json({ anchor }) : new Response(bytes))).rejects.toThrow("No valid pApp release")
  }
})
test("fall back across providers and invalid newer releases, excluding expired providers", async () => {
  const { id, manifest, key } = await fixture(), valid = await record(manifest, key)
  const bad = { ...valid.ad, functionality: { ...valid.ad.functionality, variant: { ...valid.ad.functionality.variant, tag: "not-a-timestamp" } } }
  valid.ad.providers.unshift({ ...valid.ad.providers[0], origin: "https://expired.test", expireTime: "2000-01-01T00:00:00Z" }, { ...valid.ad.providers[0], origin: "https://offline.test" })
  const result = await loadLatestRelease(id, ["https://index.test"], indexFetch(id, [bad, valid.ad]), async (origin, path) => {
    expect(origin).not.toBe("https://expired.test")
    if (origin === "https://offline.test") return new Response(null, { status: 503 })
    return path.endsWith("/GetProtectedValueAnchor") ? Response.json({ anchor: valid.anchor }) : new Response(valid.bytes)
  })
  expect(result.manifest.version).toBe(1)
})
test("a generic gateway redirects and bootstraps an app it has never seen", async () => {
  const { id } = await fixture()
  const gateway = createGateway({ gateway: "apps.test", worker: "// generic worker" })
  const redirect = await gateway(new Request(`https://apps.test/redirect?id=${id}`))
  expect(redirect.status).toBe(303)
  expect(redirect.headers.get("location")).toBe(`https://${id}.apps.test/`)
  expect(await (await gateway(new Request(`https://${id}.apps.test/`))).text()).toContain("/bootstrap.js")
  expect(await (await gateway(new Request(`https://${id}.apps.test/sw.js`))).text()).toBe("// generic worker")
})

test("select the highest timestamp across indices despite refreshed older advertisements", async () => {
  const { id, manifest, key } = await fixture()
  const older = await record(manifest, key)
  // Version numbers are metadata; release selection follows the signed tag.
  const { signature: _signature, ...unsigned } = manifest
  const newerManifest = await signManifest(key, { ...unsigned, version: 1, functionality: { ...manifest.functionality, variant: { ...manifest.functionality.variant, tag: releaseTag(new Date("2026-11-02T00:00:00Z")) } } })
  const newer = await record(newerManifest, key)
  const ads = new Map([["https://stale.test", [older.ad]], ["https://fresh.test", [older.ad, newer.ad]]])
  const result = await loadLatestRelease(id, [...ads.keys()], (async (input, init) => {
    const query = JSON.parse(String(init?.body))
    expect(query.sql).toContain("JSON_UNQUOTE(JSON_EXTRACT(advertisement, '$.functionality.variant.tag')) desc")
    return Response.json({ columns: ["advertisement"], rows: ads.get(new URL(String(input)).origin)!.map(ad => [ad]) })
  }) as typeof fetch, async (_origin, path, _proposer, init) => {
    if (path.endsWith("/GetProtectedValueAnchor")) {
      expect(JSON.parse(String(init?.body)).key).toBe(newer.anchor.key)
      return Response.json({ anchor: newer.anchor })
    }
    expect(path).toContain(newer.cid)
    return new Response(newer.bytes)
  })
  expect(result.functionality.variant?.tag).toBe(newerManifest.functionality.variant?.tag)
})

test("reject substituted variant CIDs, signatures, and timestamp tags", async () => {
  const { id, manifest, key } = await fixture()
  const entry = await record(manifest, key)
  const wrongTag = { ...entry.ad, functionality: { ...entry.ad.functionality, variant: { ...entry.ad.functionality.variant, tag: releaseTag(new Date("2026-11-03T00:00:00Z")) } } }
  for (const [ad, anchor] of [
    [entry.ad, { ...entry.anchor, cid: id }],
    [entry.ad, { ...entry.anchor, signature: entry.anchor.signature.slice(0, -4) + "AAAA" }],
    [wrongTag, entry.anchor],
  ] as const) {
    await expect(loadLatestRelease(id, ["https://index.test"], indexFetch(id, [ad]), async () => Response.json({ anchor }))).rejects.toThrow("No valid pApp release")
  }
})
