import { test, expect } from "bun:test"
import { chromium } from "playwright"
import { generateKeyPair } from "dpop"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { KvstoreClient, packFrontend, publishFiles, publishDirectory, downloadFiles, downloadToDirectory } from "../../proposer/app-packer/index.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { storage, index, keyFromFile, principal, fund, advertise, signAdvertisement } from "../routing/helpers.ts"

const echo = "http://echo-envoy.index-ns.svc.cluster.local:8080"
const root = new URL("../../", import.meta.url).pathname

test("signed OCI frontend runs from file:// and routes paid browser echo requests without a proxy", async () => {
  const proposer = await keyFromFile("pusher")
  const variant = await keyFromFile("oci-provider")
  const customer = await generateKeyPair("ES256", { extractable: true })
  const owner = await principal(proposer)
  const variantOwner = await principal(variant)
  expect(owner).not.toBe(variantOwner)
  for (const [key, origins] of [[proposer, [storage, index]], [variant, [storage]], [customer, [storage, index]]] as const) {
    for (const origin of origins) await fund(key, origin)
  }
  const publishClient = new KvstoreClient(storage, proposer, createAuthenticatedFetch(proposer))
  const variantClient = new KvstoreClient(storage, variant, createAuthenticatedFetch(variant))
  const reader = new KvstoreClient(storage, undefined, createAuthenticatedFetch(customer))
  const functionality = {
    behavior: { maintainer: owner, name: "echo/behavior", tag: "v1" },
    variant: { maintainer: variantOwner, name: "echo/variant", tag: "v1" },
  }
  await publishDirectory(publishClient, functionality.behavior, root + "examples/echo-server/behavior")
  await publishFiles(variantClient, functionality.variant, {
    "behavior.json": new TextEncoder().encode(JSON.stringify({ behavior: functionality.behavior })),
    "variant.md": new Uint8Array(await Bun.file(root + "examples/echo-server/variant/variant.md").arrayBuffer()),
  })
  const behavior = await downloadFiles(reader, functionality.behavior)
  expect(new TextDecoder().decode(behavior["behavior.md"])).toContain("POST /echo")
  const definition = await downloadFiles(reader, functionality.variant)
  expect(JSON.parse(new TextDecoder().decode(definition["behavior.json"])).behavior).toEqual(functionality.behavior)
  await advertise(proposer, await signAdvertisement(proposer, {
    functionality,
    providers: [{ origin: echo, principal: owner, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() }],
  }))
  const scoring = await Bun.file(root + "testing/routing/scoring.json").json()
  const publication = { maintainer: owner, name: "echo/frontend", tag: "v1" }
  const files = await packFrontend(root + "examples/echo-server/frontend/index.ts", { indices: [index], providerScorings: [scoring], functionality }, await Bun.file(root + "examples/echo-server/frontend/index.html").text())
  await publishFiles(publishClient, publication, files)
  // The expected proposer is supplied by the launcher, not the downloaded page.
  await expect(downloadFiles(reader, { ...publication, maintainer: variantOwner })).rejects.toThrow()
  const balance = async () => {
    const response = await createAuthenticatedFetch(customer)(index + "/account.v1.AccountService/GetBalance", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(response.ok).toBe(true)
    return BigInt((await response.json()).balance)
  }
  const before = await balance()
  const dir = await mkdtemp(join(tmpdir(), "paid-browser-"))
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    const entry = await downloadToDirectory(reader, publication, join(dir, "app"))
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    const calls: { url: string; method: string; authorization?: string; body: string | null }[] = []
    page.on("request", request => calls.push({ url: request.url(), method: request.method(), authorization: request.headers()["authorization"], body: request.postData() }))
    const responses: { url: string; method: string; status: number }[] = []
    page.on("response", response => responses.push({ url: response.url(), method: response.request().method(), status: response.status() }))
    const jwk = await crypto.subtle.exportKey("jwk", customer.privateKey)
    await page.addInitScript(key => { globalThis.PAID_CLIENT_KEY = key }, jwk)
    await page.goto(pathToFileURL(entry).href)
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true", undefined, { timeout: 15000 }).catch(async error => {
      throw new Error(`Frontend startup failed: ${await page.locator("output").textContent()}; ${errors.join("; ")}`, { cause: error })
    })
    for (const message of ["Hello from a signed OCI app", "Unicode: 你好 <script> & ? #"]) {
      await page.locator("input").fill(message)
      await page.locator("button").click()
      await page.waitForFunction(expected => document.querySelector("output")?.textContent === expected, message, { timeout: 15000 }).catch(async error => {
        throw new Error(`Echo failed: ${await page.locator("output").textContent()}; ${errors.join("; ")}`, { cause: error })
      })
    }
    let deducted = false
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await balance() < before) { deducted = true; break }
      await Bun.sleep(250)
    }
    expect(deducted).toBe(true)
    expect(errors).toEqual([])
    expect(calls.some(call => new URL(call.url).hostname === "paid.invalid")).toBe(false)
    expect(calls.some(call => call.url === index + "/index.v1.IndexService/SearchProvider" && call.authorization?.startsWith("Bearer "))).toBe(true)
    const echoCalls = calls.filter(call => call.url === echo + "/echo" && call.method === "POST")
    expect(echoCalls).toHaveLength(2)
    for (const call of echoCalls) {
      const claims = JSON.parse(Buffer.from(call.authorization!.split(".")[1], "base64url").toString())
      expect(claims.htu).toBe(echo + "/echo")
      expect(claims.htm).toBe("POST")
      expect(JSON.parse(call.body!).message).toBeTruthy()
    }
    expect(echoCalls[0].authorization).not.toBe(echoCalls[1].authorization)
    expect(responses.filter(r => r.url === echo + "/echo" && r.method === "POST").map(r => r.status)).toEqual([200, 200])
    // Browser preflights are not always exposed as Playwright request events.
    // Check the gateway explicitly as well, without authorization.
    const preflight = await fetch(index + "/index.v1.IndexService/SearchProvider", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "authorization,connect-protocol-version,content-type" } })
    expect(preflight.ok).toBe(true)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null")
    expect((await fetch(echo + "/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":"unpaid"}' })).status).toBe(403)
    // A signed proof alone is insufficient without fixture credit.
    const unfunded = await generateKeyPair("ES256")
    expect((await createAuthenticatedFetch(unfunded)(echo + "/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":"unfunded"}' })).status).toBe(403)
  } finally {
    await browser.close()
    await rm(dir, { recursive: true, force: true })
  }
}, 120000)
