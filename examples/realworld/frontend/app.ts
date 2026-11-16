import { BrowserCashierAccessTokenProvider, parseCashierConfig } from "../../../applications/cashier/src/lib.ts"
import { createClient, type Config } from "../client.ts"
import { createRemoteJWKSet, jwtVerify } from "jose"
declare global { var PAID_CONFIG: Config; var PAID_CLIENT_KEY: JsonWebKey | undefined; var PAID_CASHIER_CONFIG: string | undefined }
import { runFrontend } from "./ui.ts"
async function start() {
  const config = globalThis.PAID_CONFIG
  let authentication: Parameters<typeof createClient>[1]
  if (globalThis.PAID_CASHIER_CONFIG) {
    const wallet = parseCashierConfig(globalThis.PAID_CASHIER_CONFIG)
    const account = wallet.accounts[0], payment = account.payments[0]
    if (!payment) throw new Error("Configure a browser payment method")
    authentication = new BrowserCashierAccessTokenProvider(wallet, account.principal, payment)
  } else {
    const jwk = globalThis.PAID_CLIENT_KEY
    if (!jwk) throw new Error("Provision a browser cashier wallet or a fixture-funded PAID client key")
    const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
    authentication = { privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]) }
  }
  const client = createClient(config, authentication)
  await runFrontend(config, client)
}
start().catch(e => { document.querySelector("#status")!.textContent = e.message })
