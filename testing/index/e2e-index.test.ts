import { expect, test } from "bun:test"
import { generateKeyPair } from "dpop"
import { Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, DummyDriver } from "kysely"
import { authenticated, fund, index, search } from "../routing/helpers.ts"

const fixture = await Bun.file("/etc/routing/fixture.json").json()

test("provider API preserves scoring and direct SQL provides an independently metered alternative", async () => {
  const apiKey = await generateKeyPair("ES256", { extractable: true })
  await fund(apiKey, index)
  const providers = await search(apiKey, { functionality: fixture.functionality, providerScorings: [fixture.scoring], limit: 100 })
  expect(providers.providerAdvertisements.length).toBeGreaterThanOrEqual(3)
  const scores = providers.providerAdvertisements.map((ad: any) => ad.providers[0].scores[0])
  for (const score of scores) {
    expect(score.scoringFunctionality).toEqual(fixture.scoring)
    expect(score.score).toBeGreaterThan(0)
  }
  for (let i = 1; i < scores.length; i++) expect(scores[i - 1].score).toBeGreaterThanOrEqual(scores[i].score)

  // A separate payer makes the observed deduction attributable to SQL alone.
  const sqlKey = await generateKeyPair("ES256", { extractable: true })
  await fund(sqlKey, index)
  const auth = authenticated(sqlKey)
  const balance = async () => {
    const response = await auth(index + "/account.v1.AccountService/GetBalance", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(response.status).toBe(200)
    return BigInt((await response.json()).balance ?? 0)
  }
  const before = await balance()
  // Compile entirely on the client; DummyDriver never opens a database socket.
  const builder = new Kysely<{ "routing.advertisements": { id: string, ingress_time: number, advertisement: string } }>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: db => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  })
  const compiled = builder.selectFrom("routing.advertisements")
    .select(["id", "ingress_time", "advertisement"])
    .where("ingress_time", ">", 0).orderBy("ingress_time", "desc").limit(100).compile()
  expect(compiled.parameters).toEqual([0, 100])
  const query = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: compiled.sql, parameters: compiled.parameters }) }
  const anonymous = await fetch(index + "/sql", query)
  expect(anonymous.ok).toBe(false)
  const response = await auth(index + "/sql", query)
  expect(response.status).toBe(200)
  const result = await response.json()
  expect(result.columns).toEqual(["id", "ingress_time", "advertisement"])
  expect(result.rows.length).toBeGreaterThanOrEqual(3)
  for (const row of result.rows) {
    expect(row.every((value: unknown) => typeof value === "string")).toBe(true)
    expect(JSON.parse(row[2]).providers.length).toBeGreaterThan(0)
  }
  for (let i = 0; i < 40; i++) {
    if (await balance() < before) return
    await Bun.sleep(250)
  }
  throw new Error("SQL request did not cause a meter deduction")
}, 60_000)
