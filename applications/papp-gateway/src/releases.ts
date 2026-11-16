import { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql } from "kysely"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { verifyManifest, type PappManifest } from "../../papp-sdk/src/lib.ts"
import { variantKey, verifyReleaseVariant } from "../../papp-sdk/src/variant.ts"
import { sameFunctionality } from "../../router/src/types.ts"

// Timestamp tags select releases; signed variant anchors address their manifests.
export async function loadLatestRelease(id: string, indices: string[], paid: typeof fetch, load: (origin: string, path: string, proposer: string, init?: RequestInit) => Promise<Response> = (origin, path, _proposer, init) => paid(origin + path, init)) {
  const db = new Kysely<any>({ dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => new DummyDriver(), createIntrospector: d => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() } })
  const query = db.selectFrom("advertisements").select("advertisement").where(sql`JSON_UNQUOTE(JSON_EXTRACT(advertisement, '$.functionality.variant.name'))`, "=", id).orderBy(sql`JSON_UNQUOTE(JSON_EXTRACT(advertisement, '$.functionality.variant.tag'))`, "desc").limit(100).compile()
  let last: unknown
  const advertisements: any[] = []
  for (const index of indices) {
    try {
      const response = await paid(index + "/sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: query.sql, parameters: query.parameters }) })
      if (!response.ok) throw new Error(`index discovery: ${response.status}`)
      const result = await response.json(), pos = result.columns.indexOf("advertisement")
      for (const row of result.rows) advertisements.push(typeof row[pos] === "string" ? JSON.parse(row[pos]) : row[pos])
    } catch (error) { last = error }
  }
  advertisements.sort((a, b) => String(b.functionality?.variant?.tag ?? "").localeCompare(String(a.functionality?.variant?.tag ?? "")))
  for (const ad of advertisements) {
    try {
      const f = ad.functionality
      if (f?.variant?.name !== id || !f.variant.maintainer) continue
      const key = variantKey(f)
      for (const provider of ad.providers ?? []) {
        try {
          const origin = new URL(provider.origin)
          if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || !provider.principal || !(Date.parse(provider.expireTime) > Date.now())) continue
          const variantResponse = await load(origin.origin, "/kvstore.v1.MeteredStorageService/GetProtectedValueAnchor", f.variant.maintainer, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ owner: f.variant.maintainer, key }) })
          if (!variantResponse.ok) throw new Error(`release variant: ${variantResponse.status}`)
          const cid = CID.parse(await verifyReleaseVariant((await variantResponse.json()).anchor, f))
          if (cid.code !== 0x55 || cid.multihash.code !== sha256.code) throw new Error("manifest must use a raw SHA-256 CID")
          const response = await load(origin.origin, `/applications/user/public/value/${cid}`, f.variant.maintainer)
          if (!response.ok) throw new Error(`release manifest: ${response.status}`)
          const bytes = new Uint8Array(await response.arrayBuffer())
          if (!CID.createV1(0x55, await sha256.digest(bytes)).equals(cid)) throw new Error("release manifest CID mismatch")
          const manifest = await verifyManifest(JSON.parse(new TextDecoder().decode(bytes)) as PappManifest, id)
          if (manifest.proposer !== f.variant.maintainer || !sameFunctionality(manifest.functionality, f)) throw new Error("release functionality mismatch")
          return { manifest, functionality: f }
        } catch (error) { last = error }
      }
    } catch (error) { last = error }
  }
  throw new Error(`No valid pApp release: ${last instanceof Error ? last.message : "not published"}`)
}
