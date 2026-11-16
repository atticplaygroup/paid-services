import { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql } from "kysely"
import { sameFunctionality } from "../../router/src/types.ts"
import type { Functionality } from "../../router/src/lib.ts"
import type { Router } from "@helia/interface"
import { multiaddr } from "@multiformats/multiaddr"
import { CID } from "multiformats/cid"
export interface IndexRoutingConfig { indices: string[]; functionality: Functionality; fetch: typeof fetch }
// A delegated routing adapter: PAID's index is the authority for provider
// advertisements; Helia consumes the resulting providers through its Router API.
export function paidIndexRouting(config: IndexRoutingConfig): Router {
  return { name: "paid-index", async *findProviders(_cid, options) {
    const db = new Kysely<any>({ dialect: { createAdapter: () => new MysqlAdapter(), createDriver: () => new DummyDriver(), createIntrospector: d => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler() } })
    const query = db.selectFrom("advertisements").select("advertisement").where(sql`JSON_UNQUOTE(JSON_EXTRACT(advertisement, '$.functionality.variant.name'))`, "=", config.functionality.variant?.name).orderBy("ingress_time", "desc").limit(100).compile()
    const seen = new Set<string>()
    const failures: Error[] = []
    for (const index of config.indices) {
      options?.signal?.throwIfAborted()
      let response: Response
      try {
        response = await config.fetch(index + "/sql", { method: "POST", signal: options?.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: query.sql, parameters: query.parameters }) })
      } catch (error) {
        options?.signal?.throwIfAborted()
        failures.push(new Error(`Provider lookup at ${index}/sql failed`, { cause: error }))
        continue
      }
      if (!response.ok) {
        failures.push(new Error(`Provider lookup at ${index}/sql returned HTTP ${response.status}`))
        continue
      }
      const result = await response.json(), column = result.columns.indexOf("advertisement")
      for (const row of result.rows) {
        const ad = typeof row[column] === "string" ? JSON.parse(row[column]) : row[column]
        if (!sameFunctionality(ad.functionality, config.functionality)) continue
        for (const provider of ad.providers ?? []) {
          if (seen.has(provider.origin) || Date.parse(provider.expireTime) <= Date.now()) continue
          const url = new URL(provider.origin)
          if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.username || url.password) continue
          seen.add(url.origin)
          yield { id: CID.createV1(0x72, CID.parse(provider.principal).multihash), multiaddrs: [multiaddr(`/${/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ? "ip4" : "dns4"}/${url.hostname}/tcp/${url.port || (url.protocol === "https:" ? "443" : "80")}${url.protocol === "https:" ? "/tls/http" : "/http"}`)], protocols: ["transport-paid-s3"], router: "paid-index", origin: url.origin } as any
        }
      }
    }
    if (!seen.size) throw new AggregateError(failures, `No matching unexpired file providers in the configured indexes for ${config.functionality.variant?.name}`)
  } }
}
