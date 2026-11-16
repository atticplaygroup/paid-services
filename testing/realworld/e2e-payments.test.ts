import { keyFromFile, principal, signAdvertisement } from "../routing/helpers.ts"
import { createIndexClient, fromJson, ProviderAdvertisementSchema } from "../../applications/router/src/lib.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { test, expect } from "bun:test"
import { checkGatewayCORS } from "./cors.ts"
import { chromium } from "playwright"
import { relayDevnetFaucet } from "../../examples/realworld/devnet-faucet.ts"

test("Envoy restricts browser origins without bypassing PAID authentication", async () => {
  for (const url of [
    "http://localhost:18182/exchange.v1.ExchangeService/ListPaymentMethods",
    "http://localhost:18183/sql",
    "http://localhost:18184/index.v1.IndexService/SearchProvider",
    "http://localhost:18185/account.v1.AccountService/GetBalance",
  ]) await checkGatewayCORS(url, ["http://localhost:3001", "http://127.0.0.1:3001"], ["https://untrusted.example", "null"])
  // This public Go endpoint reaches the backend without PAID authentication.
  // It must not reflect denied origins and bypass Envoy's configured allowlist.
  for (const origin of ["http://localhost:3001", "https://untrusted.example", "null"]) {
    const response = await fetch("http://localhost:18182/.well-known/jwks.json", { headers: { origin } })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin === "http://localhost:3001" ? origin : null)
    expect((await response.json()).keys.length).toBeGreaterThan(0)
  }
})

// Run after deploy-payments.sh with exchange :18182 and SQL :18183 forwards.
// This test uses a fresh wallet, the public devnet faucet and actual Sui transfers.
test("browser funds the exchange from an empty wallet, redeems points, and reads paid SQL", async () => {
  const config = await Bun.file(process.env.REALWORLD_CONFIG_FILE!).json()
  const signer = await keyFromFile("oci-provider")
  for (const [name, origin] of [["sql", "http://sql.localhost:18183"], ["objects", "http://objects.localhost:18185"]] as const) {
    const ad = await signAdvertisement(signer, {functionality:config[name],providers:[{origin,principal:await principal(signer),coinType:1,coinEnvironment:2,price:1,updateTime:new Date().toISOString(),expireTime:new Date(Date.now()+3600000).toISOString()}]})
    await createIndexClient("http://localhost:18184",createAuthenticatedFetch(signer)).advertise({advertisement:fromJson(ProviderAdvertisementSchema,ad)})
  }
  config.indices = ["http://index.localhost:18184"]
  const manifestProcess = Bun.spawn(["node", "testing/quickstart/chart/files/prepare-values.mjs", "http://localhost:18182"], { stdout: "pipe" })
  const generated = JSON.parse(await new Response(manifestProcess.stdout).text())
  expect(await manifestProcess.exited).toBe(0)
  const manifest = generated.provider.env.providerManifest
  const built = await Bun.build({ entrypoints: ["testing/realworld/payment-browser.ts"], target: "browser" })
  if (!built.success) throw new AggregateError(built.logs, "payment browser build failed")
  const script = await built.outputs[0].text()
  const ui = await Bun.build({entrypoints:["examples/realworld/frontend/app.ts"],target:"browser"})
  if (!ui.success) throw new AggregateError(ui.logs,"payment UI build failed")
  const uiScript = await ui.outputs[0].text()
  let faucetCalls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 3001, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/v2/gas") { faucetCalls++; return relayDevnetFaucet(request) }
    if (path === "/ui.html") return new Response(Bun.file("examples/realworld/frontend/index.html"))
    if (path === "/ui-app.js") return new Response(uiScript,{headers:{"content-type":"text/javascript"}})
    if (path === "/config.json") return Response.json(config)
    if (path === "/probe.js") return new Response(script, { headers: { "content-type": "text/javascript" } })
    if (path === "/.well-known/paid_provider_manifest.json") return new Response(manifest, { headers: { "content-type": "application/json" } })
    return new Response('<script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } })
  } })
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    const endpoints = new Set<string>()
    page.on("response", response => { if (response.ok()) endpoints.add(new URL(response.url()).pathname) })
    await page.goto("http://localhost:3001")
    await page.waitForFunction(() => typeof (globalThis as any).probe === "function")
    const result = await page.evaluate(() => (globalThis as any).probe())
    await page.addScriptTag({url:"http://localhost:3001/ui-app.js",type:"module"})
    await page.getByRole("heading",{name:"Global feed",exact:true}).waitFor({state:"visible",timeout:30000})
    expect(await page.locator("#account").textContent()).toBe("Guest")
    expect(await page.evaluate(() => (globalThis as any).PAID_CLIENT_KEY)).toBeUndefined()
    expect(result.before).toBe("0")
    expect(result.sql).toEqual({ columns: ["paid"], rows: [["1"]] })
    expect(BigInt(result.creditBefore)).toBeGreaterThan(0n)
    expect(BigInt(result.creditAfter)).toBeLessThan(BigInt(result.creditBefore))
    expect(result.articlesRead).toBe(true)
    expect(result.mediaRendered).toBe(true)
    expect(result.cid).toMatch(/^b[a-z2-7]+$/)
    expect(faucetCalls).toBe(1)
    for (const method of ["ListPaymentMethods", "GetChallenge", "Deposit", "BuyPoints"]) {
      expect(endpoints.has(`/exchange.v1.ExchangeService/${method}`)).toBe(true)
    }
    expect(endpoints.has("/account.v1.AccountService/DepositOrCreateAccount")).toBe(true)
    expect(endpoints.has("/sql")).toBe(true)
    expect(endpoints.has("/kvstore.v1.MeteredStorageService/GetCASValue")).toBe(true)
    expect(endpoints.has("/index.v1.IndexService/SearchProvider")).toBe(true)
  } finally { await browser.close(); await server.stop(true) }
}, 300000)
