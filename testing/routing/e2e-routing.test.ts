import { beforeAll, describe, expect, it } from "bun:test"
import { generateKeyPair } from "dpop"
import { createRoutedFetch, createAverageScoreRanker, discover, Code, createIndexClient } from "../../applications/router/src/lib.ts"
import { KvstoreClient, loadDefinition, loadFunctionality, digest, definitionStorage } from "./functionalities/oci/ts/index.ts"
import { storage, index, oci, keyFromFile, principal, authenticated, fund, signAdvertisement, advertise, search } from "./helpers.ts"

const fixture = await Bun.file("/etc/routing/fixture.json").json()
let key: CryptoKeyPair, auth: ReturnType<typeof authenticated>
let providerKey: CryptoKeyPair
// Every remote URL in this suite is a party's Envoy gateway. The only local
// server below is the client's own middleware, which curl calls over loopback.
async function balance(origin: string, payer: CryptoKeyPair = key): Promise<bigint> {
  const res = await authenticated(payer)(origin + "/account.v1.AccountService/GetBalance", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
  expect(res.status).toBe(200)
  return BigInt((await res.json()).balance ?? 0)
}
async function eventuallyDeducted(origin: string, before: bigint, payer: CryptoKeyPair) {
  for (let i = 0; i < 40; i++) { if (await balance(origin, payer) < before) return; await Bun.sleep(250) }
  throw new Error(`no metering deduction at ${origin}`)
}
beforeAll(async () => {
  key = await keyFromFile("puller")
  auth = authenticated(key)
  providerKey = await keyFromFile("oci-provider")
  expect(await principal(key)).not.toBe(await principal(providerKey))
  for (const origin of [storage, index, oci]) await fund(key, origin)
})
describe("routing through metered party gateways", () => {
  it("finds signed definitions through advertised OCI and enforces maintainer linkage", async () => {
    expect(fixture.functionality.behavior.maintainer).not.toBe(fixture.functionality.variant.maintainer)
    // The same OCI conversion library used by a puller verifies the requested
    // owner's anchor before returning any definition content.
    for (const definition of [fixture.functionality.behavior, fixture.functionality.variant]) {
      const providers = await discover({ indices: [index], providerRanker: createAverageScoreRanker({ providerScorings: [fixture.scoring] }), fetch: auth }, definitionStorage(definition, fixture.functionality.behavior))
      expect(providers.map(p => p.origin)).toEqual([oci])
      // Pull through the discovered provider's signature-checking OCI layer,
      // following the existing puller pattern, before inspecting the content.
      const manifest = await auth(`${providers[0].origin}/v2/${definition.maintainer}/${definition.name}/manifests/${definition.tag}`)
      expect(manifest.status).toBe(200)
      expect((await manifest.json()).schemaVersion).toBe(2)
    }
    const client = new KvstoreClient(storage, undefined, auth)
    const scoreBehavior = await loadDefinition(client, fixture.scoring.behavior)
    const scoreVariant = await loadDefinition(client, fixture.scoring.variant)
    expect(scoreBehavior["behavior.md"].length).toBeGreaterThan(0)
    expect(new TextDecoder().decode(scoreVariant["variant.md"])).toContain("Unix milliseconds")
    const definitions = await loadFunctionality(client, fixture.functionality)
    expect(definitions.collection).toEqual(fixture.collection)
    expect(definitions.behavior["behavior.md"].length).toBeGreaterThan(0)
    await expect(loadDefinition(client, { ...fixture.functionality.behavior, maintainer: fixture.functionality.variant.maintainer })).rejects.toThrow("definition signature or content invalid")
    const corrupt = new KvstoreClient(storage, undefined, auth)
    corrupt.getBlob = async () => new TextEncoder().encode("tampered")
    await expect(loadDefinition(corrupt, fixture.functionality.behavior)).rejects.toThrow()
  })
  it("indexes exact functionality, ranks by ingress time, and bounds requests", async () => {
    const query = (body: any) => search(key, { providerScorings: [fixture.scoring], ...body })
    const page = await query({ functionality: fixture.functionality, limit: 2 })
    expect(page.providerAdvertisements.map((r: any) => r.providers[0].origin)).toEqual([fixture.deadHigh, oci])
    expect(page.providerAdvertisements[0].providers[0].scores[0].scoringFunctionality).toEqual(fixture.scoring)
    expect(page.providerAdvertisements[1].providers[0].principal).toBe(await principal(providerKey))
    expect(page.providerAdvertisements[0].providers[0].scores[0].score).toBeGreaterThan(page.providerAdvertisements[1].providers[0].scores[0].score)
    const next = await query({ functionality: fixture.functionality, limit: 2, offset: page.nextOffset })
    expect(next.providerAdvertisements.map((r: any) => r.providers[0].origin)).toEqual([fixture.deadLow])
    const none = await query({ functionality: { ...fixture.functionality, variant: { ...fixture.functionality.variant, tag: "missing" } } })
    expect(none.providerAdvertisements).toEqual([])
    const unsupportedScoring = { ...fixture.scoring, variant: { ...fixture.scoring.variant, tag: "unsupported" } }
    const partial = await query({ functionality: fixture.functionality, providerScorings: [unsupportedScoring, fixture.scoring] })
    expect(partial.providerAdvertisements).toHaveLength(3)
    for (const advertisement of partial.providerAdvertisements) for (const provider of advertisement.providers) {
      expect(provider.scores.map((score: any) => score.scoringFunctionality)).toEqual([fixture.scoring])
    }
    expect((await query({ functionality: fixture.functionality, providerScorings: [unsupportedScoring] })).providerAdvertisements).toEqual([])

    await expect(query({ functionality: fixture.functionality, limit: 101 })).rejects.toMatchObject({ code: Code.InvalidArgument })
    await expect(createIndexClient(index).searchProvider({})).rejects.toThrow()
  })
  it("rejects tampered advertisements and excessive expiry", async () => {
    const provider = { origin: oci, principal: await principal(providerKey), coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() }
    const valid = await signAdvertisement(key, { functionality: fixture.functionality, providers: [provider] })
    const post = (a: any) => advertise(key, a)
    await expect(post({ ...valid, providers: [{ ...provider, price: 99 }] })).rejects.toMatchObject({ code: Code.PermissionDenied })
    await expect(post(await signAdvertisement(key, { functionality: fixture.functionality, providers: [{ ...provider, expireTime: new Date(Date.now() + 31 * 86400000).toISOString() }] }))).rejects.toMatchObject({ code: Code.InvalidArgument })
    const other = await generateKeyPair("ES256")
    await expect(post(await signAdvertisement(other, { functionality: fixture.functionality, providers: [provider] }))).rejects.toMatchObject({ code: Code.PermissionDenied })
    await expect(post({ ...valid, providers: Array(33).fill(provider) })).rejects.toMatchObject({ code: Code.InvalidArgument })
    await expect(post(await signAdvertisement(key, { functionality: fixture.functionality, providers: [{ ...provider, principal: "" }] }))).rejects.toMatchObject({ code: Code.InvalidArgument })
    await expect(post(await signAdvertisement(key, { functionality: fixture.functionality, providers: [{ ...provider, scores: [{ scoringFunctionality: fixture.scoring, score: 999 }] }] }))).rejects.toMatchObject({ code: Code.InvalidArgument })
  })
  it("local fetch interceptor discovers directly, fails over, and pays index as the client", async () => {
    const parties = [index, oci, storage]
    const payers = [key, key, providerKey]
    const initial = await Promise.all(parties.map((origin, i) => balance(origin, payers[i])))
    const attempts: string[] = []
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, proxy: process.env.PULLER_OUTPROXY_URL! })
    const providerRanker = createAverageScoreRanker({ providerScorings: [fixture.scoring] })
    const routed = createRoutedFetch({ indices: [index], providerRanker, fetch: fetcher, timeoutMs: 5000, onAttempt: origin => attempts.push(origin) })
    const local = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
      const url = new URL(request.url)
      return routed(new Request("https://paid.invalid" + url.pathname + url.search, request), { functionality: fixture.functionality })
    } })
    try {
      for (let i = 0; i < 3; i++) {
        const layer = fixture.layers[i]
        const process = Bun.spawn(["curl", "--fail", "--silent", "--show-error", `http://127.0.0.1:${local.port}/v2/${fixture.collection.owner}/${fixture.collection.name}/blobs/${layer.digest}`], { stdout: "pipe", stderr: "pipe" })
        const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer())
        const stderr = await new Response(process.stderr).text()
        expect(await process.exited, stderr).toBe(0)
        expect(Buffer.from(bytes).toString("base64")).toBe(fixture.contents[i])
        expect(await digest(bytes)).toBe(layer.digest)
      }
      expect(attempts).toEqual(Array(3).fill([fixture.deadHigh, oci]).flat())
    } finally { local.stop(true) }
    for (let i = 0; i < parties.length; i++) await eventuallyDeducted(parties[i], initial[i], payers[i])
  }, 60000)
  it("expired advertisements are excluded without requiring storage cleanup", async () => {
    const expiring = await generateKeyPair("ES256")
    await fund(expiring, index)
    const ad = await signAdvertisement(expiring, { functionality: fixture.functionality, providers: [{ origin: "http://expired.example", principal: await principal(expiring), coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 1200).toISOString() }] })
    expect((await advertise(expiring, ad)).ingressTime).toBeDefined()
    await Bun.sleep(1500)
    const res = await search(key, { functionality: fixture.functionality, providerScorings: [fixture.scoring] })
    expect(res.providerAdvertisements.flatMap((r: any) => r.providers.map((p: any) => p.origin))).not.toContain("http://expired.example")
  })
})
