import { until } from '../shared/wait.ts'
import { refreshRealworldAdvertisements } from "./refresh.ts"
import { test, expect } from "bun:test"
import { checkGatewayCORS } from "./cors.ts"
import { launchBrowser } from "./browsers.ts"
import { expect as browserExpect } from "playwright/test"
import { generateKeyPair } from "dpop"
import { SignJWT, importJWK } from "jose"
import { createClient, verifyProposer, type Config } from "../../examples/realworld/client.ts"
import { keyFromFile, fund, principal, index, storage, advertise, signAdvertisement } from "../routing/helpers.ts"
import { fromJson, ProviderAdvertisementSchema } from "../../applications/router/src/lib.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { mkdir } from "node:fs/promises"

const sqlOrigin = "http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080"
const proposerOrigin = "http://realworld-proposer.pusher-ns.svc.cluster.local:3000"
const idpOrigin = "http://realworld-idp.pusher-ns.svc.cluster.local:4000"
const provider = (origin: string, who: string) => ({ origin, principal: who, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() })

test("Envoy enables browser origins by default while requiring PAID authentication", async () => {
  for (const url of [
    sqlOrigin + "/sql", index + "/index.v1.IndexService/SearchProvider",
    storage + "/account.v1.AccountService/GetBalance",
    "http://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080/account.v1.AccountService/GetBalance",
  ]) await checkGatewayCORS(url, ["https://browser.example", "null"])
  // Envoy bypasses its CORS filter for direct responses, so public discovery
  // manifests need explicit response headers independently of RPC origin policy.
  for (const origin of [sqlOrigin, index, storage]) {
    const response = await fetch(origin + "/.well-known/paid_provider_manifest.json", { headers: { origin: "https://browser.example" } })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("content-type")).toContain("application/json")
    await response.json()
  }
})

test("RealWorld API conformance and routed browser application through PAID gateways", async () => {
  const config: Config = await Bun.file(process.env.REALWORLD_CONFIG_FILE ?? "/etc/realworld/fixture.json").json()
  await refreshRealworldAdvertisements(config)
  // Repeated local runs also consume publication and replication credit.
  await fund(await keyFromFile("pusher"), storage, "1000000000000000")
  // The conversion provider pays storage with its own outgoing identity,
  // independently of the replica caller that pays the OCI gateway.
  await fund(await keyFromFile("oci-provider"), storage, "100000000000000")
  const replicaKey = await keyFromFile("puller")
  for (const origin of [storage, "http://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080"]) await fund(replicaKey, origin, "100000000000000")
  const customer = await generateKeyPair("ES256", { extractable: true })
  const paid = createAuthenticatedFetch(customer)
  for (const origin of [index, storage, sqlOrigin]) await fund(customer, origin, "100000000000000")
  const client = createClient(config, customer)
  const servers: ReturnType<typeof Bun.serve>[] = []
  let frontend: ReturnType<typeof Bun.spawn> | undefined
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
  await mkdir("/tmp/realworld-artifacts", { recursive: true })
  const balance = async (origin: string) => {
    const response = await paid(origin + "/account.v1.AccountService/GetBalance", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(response.status).toBe(200); return BigInt((await response.json()).balance)
  }
  try {
    await until(async () => { const result = await client.api("/api/articles"); return Array.isArray(result.articles) }, "initial signed baseline import")
    const before = await Promise.all([index, storage, sqlOrigin].map(balance))
    const forbidden = await paid(sqlOrigin + "/sql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: "UPDATE realworld.users SET bio='forbidden'" }) })
    expect(forbidden.status).toBe(400)
    expect((await fetch(sqlOrigin + "/sql", { method: "POST", headers: { "content-type": "application/json" }, body: '{"sql":"SELECT 1"}' })).status).toBe(403)

    // A newer advertisement from another principal must never receive the OIDC
    // token, even though the index accepts its otherwise valid signature.
    let stolenCredentials = 0, deadReadAttempts = 0
    servers.push(Bun.serve({ port: 4999, fetch() { stolenCredentials++; return Response.json({ stolen: true }) } }))
    servers.push(Bun.serve({ port: 4998, fetch() { deadReadAttempts++; return new Response("unavailable", { status: 503 }) } }))
    const attacker = await generateKeyPair("ES256", { extractable: true }); await fund(attacker, index)
    const malicious = await signAdvertisement(attacker, { functionality: config.mutation, providers: [provider("http://localhost:4999", await principal(attacker))] })
    await advertise(attacker, malicious)
    const parsed = fromJson(ProviderAdvertisementSchema, malicious)
    expect(await verifyProposer(parsed.providers[0], parsed, config.proposerPrincipal)).toBe(false)
    const owner = await keyFromFile("pusher")
    const valid = fromJson(ProviderAdvertisementSchema, await signAdvertisement(owner, { functionality: config.mutation, providers: [provider(proposerOrigin, config.proposerPrincipal)] }))
    expect(await verifyProposer(valid.providers[0], valid, config.proposerPrincipal)).toBe(true)
    valid.providers[0].origin = "http://localhost:4999"
    expect(await verifyProposer(valid.providers[0], valid, config.proposerPrincipal)).toBe(false)
    await advertise(attacker, await signAdvertisement(attacker, { functionality: config.sql, providers: [provider("http://localhost:4998", await principal(attacker))] }))
    await client.api("/api/articles")
    expect(deadReadAttempts).toBeGreaterThan(0)

    // Standard Conduit collection runs unchanged. Its HTTP adapter invokes the
    // same browser read library, never an alternative server-side read API.
    async function waitMutation(path: string, method: string, response: any, api: ReturnType<typeof createClient>) {
      if (response.article) await until(async () => { const a = (await api.api(`/api/articles/${response.article.slug}`)).article; return a.body === response.article.body && a.favorited === response.article.favorited && a.favoritesCount === response.article.favoritesCount }, "article publication")
      else if (response.profile) await until(async () => (await api.api(`/api/profiles/${encodeURIComponent(response.profile.username)}`)).profile.following === response.profile.following, "follow publication")
      else if (response.user) await until(async () => { const p = (await api.api(`/api/profiles/${encodeURIComponent(response.user.username)}`)).profile; return p.bio === response.user.bio && p.image === response.user.image }, "profile publication")
      else if (response.comment) await until(async () => (await api.api(path)).comments.some((c: any) => c.id === response.comment.id), "comment publication")
      else if (method === "DELETE" && /\/comments\/\d+$/.test(path)) await until(async () => !(await api.api(path.replace(/\/\d+$/, ""))).comments.some((c: any) => c.id === Number(path.split("/").pop())), "comment deletion")
      else if (method === "DELETE" && /^\/api\/articles\/[^/]+$/.test(path)) await until(async () => { try { await api.api(path); return false } catch (e: any) { return e.status === 404 } }, "article deletion")
    }
    servers.push(Bun.serve({ port: 3100, idleTimeout: 255, async fetch(request) {
      try {
        const url = new URL(request.url), api = createClient(config, customer)
        console.log(`Conduit adapter: ${request.method} ${url.pathname}${url.search}`)
        const rawToken = request.headers.get("authorization")?.replace(/^(Token|Bearer) /, "") ?? ""
        await api.setToken(rawToken)
        const body = ["POST", "PUT"].includes(request.method) ? await request.text() : ""
        const value = await api.api(url.pathname + url.search, request.method, body ? JSON.parse(body) : request.method === "POST" ? {} : undefined)
        // Registration/login returns a token even though the incoming call was anonymous.
        if (value.user?.token) await api.setToken(value.user.token)
        if (request.method !== "GET") await waitMutation(url.pathname, request.method, value, api)
        return Response.json(value, { status: request.method === "POST" && ["/api/users", "/api/articles"].includes(url.pathname) || request.method === "POST" && url.pathname.endsWith("/comments") ? 201 : 200 })
      } catch (e: any) { return Response.json({ errors: { body: [e.message] } }, { status: e.status ?? 500 }) }
    } }))
    const suffix = crypto.randomUUID().slice(0, 8)
    const run = Bun.spawn(["node", "testing/realworld/node_modules/newman/bin/newman.js", "run", "testing/realworld/Conduit.postman_collection.json", "--env-var", "APIURL=http://localhost:3100/api", "--env-var", `EMAIL=api-${suffix}@example.test`, "--env-var", `USERNAME=api-${suffix}`, "--env-var", "PASSWORD=fixture-password", "--timeout-request", "200000", "--reporters", "cli,json", "--reporter-json-export", "/tmp/realworld-artifacts/newman.json"], { stdout: "inherit", stderr: "inherit" })
    const exit = await run.exited
    const report = await Bun.file("/tmp/realworld-artifacts/newman.json").json()
    if (exit) console.error(report.run.failures.map((f: any) => ({ request: f.source?.name, assertion: f.error?.message })), report.run.executions.filter((e: any) => e.response?.code >= 400).map((e: any) => ({ request: e.item.name, status: e.response.code, body: Buffer.from(e.response.stream?.data ?? e.response.stream ?? []).toString().slice(0, 500) })))
    expect(exit).toBe(0)
    expect(report.run.failures).toEqual([])
    expect(report.run.stats.requests.total).toBe(32)
    expect(report.run.stats.assertions.total).toBeGreaterThan(150)
    console.log(`Conduit collection: ${report.run.stats.requests.total} requests, ${report.run.stats.assertions.total} assertions`)

    // Negative mutation tests use fixture-signed tokens directly.
    const idpKey = await importJWK(await Bun.file("/etc/dpop-keys/pusher.json").json(), "ES256")
    const fixtureToken = await new SignJWT({ email: `fixture-${suffix}@example.test`, preferred_username: `fixture-${suffix}` }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(`fixture-${suffix}`).setIssuer(config.issuer).setAudience("realworld").setIssuedAt().setExpirationTime("1h").sign(idpKey)
    await client.setToken(fixtureToken); await client.api("/api/session", "POST", {})
    const article = (await client.api("/api/articles", "POST", { article: { title: `Owned ${suffix}`, description: "ownership", body: "original", tagList: ["authorization"] } })).article
    const comment = (await client.api(`/api/articles/${article.slug}/comments`, "POST", { comment: { body: "owned comment" } })).comment
    const otherToken = await new SignJWT({ email: `other-${suffix}@example.test`, preferred_username: `other-${suffix}` }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(`other-${suffix}`).setIssuer(config.issuer).setAudience("realworld").setIssuedAt().setExpirationTime("1h").sign(idpKey)
    await client.setToken(otherToken); await client.api("/api/session", "POST", {})
    await expect(client.api(`/api/articles/${article.slug}`, "PUT", { article: { body: "stolen" } })).rejects.toMatchObject({ status: 403 })
    await expect(client.api(`/api/articles/${article.slug}`, "DELETE")).rejects.toMatchObject({ status: 403 })
    await expect(client.api(`/api/articles/${article.slug}/comments/${comment.id}`, "DELETE")).rejects.toMatchObject({ status: 403 })
    await expect(client.api("/api/articles", "POST", { article: {} })).rejects.toMatchObject({ status: 422 })
    await client.setToken("")
    await expect(client.api("/api/articles", "POST", { article: { title: "anonymous", description: "no", body: "no" } })).rejects.toMatchObject({ status: 401 })
    expect(stolenCredentials).toBe(0)

    // OIDC uses the same localhost callback as a developer's browser. The test
    // proxy forwards only to the fixture IdP; credentials never enter MySQL.
    servers.push(Bun.serve({ port: 4000, fetch(request) { return fetch(idpOrigin + new URL(request.url).pathname + new URL(request.url).search, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" }) } }))
    const frontendOrigin = "http://localhost:3001"
    const configFile = "/tmp/realworld-browser-config.json"; await Bun.write(configFile, JSON.stringify(config))
    frontend = Bun.spawn(["bun", "examples/realworld/frontend-server.ts"], { env: { ...process.env, REALWORLD_CONFIG_FILE: configFile }, stdout: "inherit", stderr: "inherit" })
    await until(async () => (await fetch(frontendOrigin)).ok, "frontend startup", 30000)
    const browserName = "chromium" as const
    for (const mode of ["original"]) {
      console.log(`RealWorld browser scenario: ${browserName}/${mode}`)
      browser = await launchBrowser(browserName)
      const context = browser.context
      await context.tracing.start({ screenshots: true, snapshots: true })
      {
        const jwk = await crypto.subtle.exportKey("jwk", customer.privateKey)
        await context.addInitScript(value => { if (location.origin === "http://localhost:3001") globalThis.PAID_CLIENT_KEY = value }, jwk)
      }
      const page = await context.newPage(), errors: string[] = [], calls: { url: string, method: string, authorization?: string }[] = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("request", request => calls.push({ url: request.url(), method: request.method(), authorization: request.headers().authorization }))
      try {
        await page.goto(frontendOrigin)
        await browserExpect(page.getByRole("heading", { name: "Global feed" })).toBeVisible({ timeout: 30000 })
        await browserExpect(page.locator("html")).toHaveAttribute("data-ready", "true", { timeout: 60000 })
        await page.getByRole("button", { name: "Log in / Register" }).click()
        await page.getByLabel("Email", { exact: true }).fill(`browser-${mode}-${suffix}@example.test`)
        await page.getByLabel("Password", { exact: true }).fill("browser-password")
        await page.getByLabel("Username (registration)").fill(`browser-${mode}-${suffix}`)
        await page.getByRole("button", { name: "Register", exact: true }).click()
        await browserExpect(page.locator("#account")).toHaveText(`browser-${mode}-${suffix}`, { timeout: 30000 })
        await page.getByRole("link", { name: "Settings", exact: true }).click()
        await page.getByLabel("Bio", { exact: true }).fill("Browser-edited profile")
        const png = Buffer.from(await Bun.file("testing/realworld/fixtures/mountains.png").arrayBuffer())
        await page.getByLabel("Upload avatar").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: png })
        await page.getByRole("button", { name: "Save settings" }).click()
        await browserExpect(page.getByRole("status")).toHaveText("Settings saved", { timeout: 180000 })
        await page.getByRole("link", { name: "New article", exact: true }).click()
        await page.getByLabel("Title", { exact: true }).fill(`Browser article ${suffix}`)
        await page.getByLabel("Description", { exact: true }).fill("Browser-written description")
        await page.getByLabel("Body", { exact: true }).fill("Browser body with Unicode 你好 <script> &")
        await page.getByLabel("Tags", { exact: true }).fill("browser, paid")
        await page.getByLabel("Attach image").setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png })
        await page.getByRole("button", { name: "Publish article" }).click()
        await browserExpect(page.getByRole("heading", { name: `Browser article ${suffix}`, exact: true })).toBeVisible({ timeout: 180000 })
        await browserExpect(page.getByAltText("Article attachment")).toHaveAttribute("src", /^blob:/)
        await browserExpect(page.getByAltText("Article attachment")).toHaveJSProperty("naturalWidth", 800)
        await browserExpect(page.getByAltText("Article attachment")).toHaveJSProperty("naturalHeight", 534)
        await browserExpect(page.locator("#article-body")).toContainText("你好 <script> &")
        await browserExpect(page.locator("#article-body script")).toHaveCount(0)
        await page.getByRole("button", { name: "Favorite (0)", exact: true }).click()
        await browserExpect(page.getByRole("button", { name: "Unfavorite (1)", exact: true })).toBeVisible({ timeout: 180000 })
        await page.getByRole("button", { name: "Unfavorite (1)", exact: true }).click()
        await browserExpect(page.getByRole("button", { name: "Favorite (0)", exact: true })).toBeVisible({ timeout: 180000 })
        await page.getByLabel("Comment", { exact: true }).fill("A browser comment")
        await page.getByRole("button", { name: "Add comment" }).click()
        await browserExpect(page.locator("#comments")).toContainText("A browser comment", { timeout: 180000 })
        await page.getByRole("button", { name: "Delete comment" }).click()
        await browserExpect(page.locator("#comments")).not.toContainText("A browser comment", { timeout: 180000 })
        await page.getByRole("link", { name: "Edit article", exact: true }).click()
        await page.getByLabel("Title", { exact: true }).fill(`Edited browser article ${suffix}`)
        await page.getByLabel("Body", { exact: true }).fill("Edited browser body")
        await page.getByRole("button", { name: "Publish article" }).click()
        await browserExpect(page.getByRole("heading", { name: `Edited browser article ${suffix}`, exact: true })).toBeVisible({ timeout: 180000 })
        const editedArticleUrl = page.url()
        // Follow another published author, inspect feed, then unfollow.
        await page.goto(`${frontendOrigin}/#/profile/fixture-${suffix}`)
        await page.getByRole("button", { name: "Follow", exact: true }).click()
        await browserExpect(page.getByRole("button", { name: "Unfollow", exact: true })).toBeVisible({ timeout: 180000 })
        await page.getByRole("link", { name: "Your feed", exact: true }).click()
        await browserExpect(page.getByRole("heading", { name: "Your feed", exact: true })).toBeVisible()
        await browserExpect(page.getByRole("heading", { name: `Owned ${suffix}` })).toBeVisible()
        await page.goto(`${frontendOrigin}/#/profile/fixture-${suffix}`)
        await page.getByRole("button", { name: "Unfollow", exact: true }).click()
        await browserExpect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible({ timeout: 180000 })
        await page.goto(editedArticleUrl)
        await page.getByRole("button", { name: "Delete article" }).click()
        await browserExpect(page.getByRole("heading", { name: "Global feed", exact: true })).toBeVisible({ timeout: 180000 })
        await page.getByRole("button", { name: "Log out", exact: true }).click()
        await page.getByRole("button", { name: "Log in / Register" }).click()
        await page.getByLabel("Email", { exact: true }).fill(`browser-${mode}-${suffix}@example.test`)
        await page.getByLabel("Password", { exact: true }).fill("browser-password")
        await page.getByRole("button", { name: "Log in", exact: true }).click()
        await browserExpect(page.locator("#account")).toHaveText(`browser-${mode}-${suffix}`, { timeout: 30000 })
        expect(errors).toEqual([])
        const writes = calls.filter(c => c.url.startsWith(proposerOrigin) && c.method !== "OPTIONS")
        expect(writes.length).toBeGreaterThan(5)
        for (const call of writes) {
          const claims = JSON.parse(Buffer.from(call.authorization!.split(".")[1], "base64url").toString())
          expect(claims.iss).toBe(config.issuer); expect(claims.htu).toBeUndefined()
        }
        for (const origin of [index, storage, sqlOrigin]) {
          const reads = calls.filter(c => c.url.startsWith(origin) && c.method !== "OPTIONS")
          expect(reads.length).toBeGreaterThan(0)
          for (const call of reads) {
            const claims = JSON.parse(Buffer.from(call.authorization!.split(".")[1], "base64url").toString())
            expect(claims.htu).toBe(call.url.split("?")[0]); expect(claims.htm).toBe(call.method)
          }
        }
        expect(stolenCredentials).toBe(0)
      } finally {
        await page.screenshot({ path: `/tmp/realworld-artifacts/${browserName}-${mode}.png`, fullPage: true }).catch(error => console.warn("Browser screenshot unavailable:", error.message))
        await context.tracing.stop({ path: `/tmp/realworld-artifacts/${browserName}-${mode}-trace.zip` }).catch(error => console.warn("Browser trace unavailable:", error.message))
      }
      await context.close()
      await browser.close(); browser = undefined
    }
    await until(async () => { const after = await Promise.all([index, storage, sqlOrigin].map(balance)); return after.every((b, i) => b < before[i]) }, "meter deductions")
    console.log("RealWorld browser, routing, OIDC, ownership, media, replication and metering checks passed")
  } finally {
    await browser?.close(); frontend?.kill(); for (const server of servers) server.stop(true)
  }
}, 2100000)


test("library offset pagination through the paid replica", async () => {
  const config: Config = await Bun.file(process.env.REALWORLD_CONFIG_FILE ?? "/etc/realworld/fixture.json").json()
  await fund(await keyFromFile("pusher"), storage, "1000000000000000")
  const customer = await generateKeyPair("ES256", { extractable: true })
  for (const origin of [index, sqlOrigin]) await fund(customer, origin, "100000000000000")
  const client = createClient(config, customer)
  const suffix = crypto.randomUUID().slice(0, 8), username = `pagination-${suffix}`
  const idpKey = await importJWK(await Bun.file("/etc/dpop-keys/pusher.json").json(), "ES256")
  const token = await new SignJWT({ preferred_username: username }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setSubject(username).setIssuer(config.issuer).setAudience("realworld").setIssuedAt().setExpirationTime("1h").sign(idpKey)
  await client.setToken(token)
  await client.api("/api/session", "POST", {})
  const create = async (title: string) => (await client.api("/api/articles", "POST", { article: { title, description: "pagination", body: "page content", tagList: ["pagination"] } })).article
  const older = await create(`Older ${suffix}`), newer = await create(`Newer ${suffix}`)
  const filtered = `/api/articles?author=${username}&tag=pagination`
  try {
    await until(async () => (await client.api(filtered)).articlesCount === 2, "filtered pagination publication")
    const firstPage = await client.api(filtered + "&limit=1&offset=0")
    const secondPage = await client.api(filtered + "&limit=1&offset=1")
    const beyond = await client.api(filtered + "&limit=1&offset=2")
    expect(firstPage.articlesCount).toBe(2)
    expect(secondPage.articlesCount).toBe(2)
    expect(firstPage.articles.map((a: any) => a.slug)).toEqual([newer.slug])
    expect(secondPage.articles.map((a: any) => a.slug)).toEqual([older.slug])
    expect(beyond).toEqual({ articles: [], articlesCount: 2 })
    await expect(client.api(filtered + "&limit=-1")).rejects.toMatchObject({ status: 422 })
  } finally {
    for (const article of [older, newer]) await client.api(`/api/articles/${article.slug}`, "DELETE")
  }
}, 240000)
