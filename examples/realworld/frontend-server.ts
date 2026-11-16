import { credentialScript } from "./credentials.ts"
import { relayDevnetFaucet } from "./devnet-faucet.ts"
const entry = new URL("frontend/app.ts", import.meta.url).pathname
const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: true })
if (!built.success) throw new AggregateError(built.logs, "frontend build failed")
const script = await built.outputs[0].text()
const config = process.env.REALWORLD_CONFIG_FILE ? await Bun.file(process.env.REALWORLD_CONFIG_FILE).json() : JSON.parse(process.env.REALWORLD_CONFIG ?? "{}")
const cashierConfig = process.env.REALWORLD_CASHIER_CONFIG_FILE ? await Bun.file(process.env.REALWORLD_CASHIER_CONFIG_FILE).text() : undefined
const clientKey = process.env.REALWORLD_CLIENT_KEY_FILE ? await Bun.file(process.env.REALWORLD_CLIENT_KEY_FILE).json() : undefined
Bun.serve({ port: Number(process.env.PORT ?? 3001), hostname: process.env.HOST ?? "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname
  if (path === "/v2/gas" && process.env.REALWORLD_DEVNET_FAUCET === "true") return relayDevnetFaucet(request)
  if (path === "/app.js") return new Response(script, { headers: { "content-type": "text/javascript" } })
  if (path === "/config.js") return new Response(`globalThis.PAID_CONFIG=${JSON.stringify(config).replace(/</g, "\\u003c")}`, { headers: { "content-type": "text/javascript", "cache-control": "no-store" } })
  if (path === "/client-key.js") return credentialScript(request, cashierConfig ? `globalThis.PAID_CASHIER_CONFIG=${JSON.stringify(cashierConfig).replace(/</g, "\\u003c")}` : clientKey ? `globalThis.PAID_CLIENT_KEY=${JSON.stringify(clientKey)}` : "/* The local launcher provisions the client key. */", !!(cashierConfig || clientKey))
  return new Response(Bun.file(new URL("frontend/index.html", import.meta.url)), { headers: { "content-type": "text/html" } })
} })
