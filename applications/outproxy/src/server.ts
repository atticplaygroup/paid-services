import { createClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { DeductionService } from "./proto/gen/es/account/v1/meter_pb.js"
import { StorageBackend } from "./proto/gen/es/kvstore/v1/kvstore_pb.js"
import * as dpop from "dpop"
import { p256 } from "@noble/curves/nist.js"

interface Config {
  listenAddr: string
  dpopPrivateKey?: string
  dpopMasterSecret?: string
  cashierAddress?: string
  insecure: boolean
  alsAddress?: string
  scheduleEnabled: boolean
  deductionDelaySeconds: number
}

function loadConfig(): Config {
  return {
    listenAddr: process.env.LISTEN_ADDR ?? ":9090",
    dpopPrivateKey: process.env.DPOP_PRIVATE_KEY || undefined,
    dpopMasterSecret: process.env.DPOP_MASTER_SECRET || undefined,
    cashierAddress: process.env.CASHIER_ADDRESS || undefined,
    insecure: process.env.INSECURE === "true",
    alsAddress: process.env.ALS_ADDRESS || undefined,
    scheduleEnabled: process.env.SCHEDULE_EXTERNAL_DEDUCTION_ENABLED === "true",
    deductionDelaySeconds: Number(process.env.EXTERNAL_DEDUCTION_DELAY_SECONDS ?? 8),
  }
}

function base64Url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

function sha256(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const input of inputs) hash.update(input)
  return new Uint8Array(hash.digest())
}

async function importP256Seed(seed: Uint8Array): Promise<dpop.KeyPair> {
  const publicKeyBytes = p256.getPublicKey(seed, false)
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) throw new Error("invalid P-256 derived key")
  const privateJwk = {
    crv: "P-256",
    d: base64Url(seed),
    kty: "EC",
    x: base64Url(publicKeyBytes.slice(1, 33)),
    y: base64Url(publicKeyBytes.slice(33)),
  }
  const publicJwk = { crv: "P-256", kty: "EC", x: privateJwk.x, y: privateJwk.y }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  ])
  return { privateKey, publicKey }
}

async function loadKeypair(privateKeyJson: string): Promise<dpop.KeyPair> {
  const jwk = JSON.parse(privateKeyJson) as JsonWebKey
  const publicJwk: JsonWebKey = {
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    ),
    crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    ),
  ])
  return { privateKey, publicKey }
}

export async function createApp(overrideConfig?: Config) {
  const config = overrideConfig ?? loadConfig()
  console.log(`outproxy starting on ${config.listenAddr}`)

  let keypair: CryptoKeyPair | undefined
  if (config.dpopPrivateKey) {
    keypair = await loadKeypair(config.dpopPrivateKey)
    console.log("DPoP key loaded")
  }

  // DeductionService client for ScheduleExternalDeduction
  let deductionClient: ReturnType<typeof createClient<typeof DeductionService>> | undefined
  if (config.alsAddress && config.scheduleEnabled) {
    const transport = createConnectTransport({
      baseUrl: config.alsAddress,
      useBinaryFormat: true,
    })
    deductionClient = createClient(DeductionService, transport)
    console.log(`deduction client configured: ${config.alsAddress}`)
  }

  const { Hono } = await import("hono")

  const app = new Hono()

  app.all("*", async (c) => {
    // The request URL is the absolute URL from the forward proxy request line
    // e.g., "http://real-target:8080/path" from "GET http://real-target:8080/path HTTP/1.1"
    const fullUrl = c.req.url
    const u = new URL(fullUrl)

    // Destination host includes port
    const destination = u.host
    const path = u.pathname + u.search

    if (!destination) {
      return c.text("Bad Request: no destination", 400)
    }

    // Use upstream-provided external request ID, or generate a new one
    const externalRequestId = c.req.header("x-external-request-id") ?? crypto.randomUUID()

    // Optionally schedule external deduction in direct mode.
    if (deductionClient && keypair && !config.cashierAddress) {
      const userId = c.req.header("x-user-id") ?? ""
      if (userId) {
        const hostParts = destination.split(":")
        const downstreamHost = hostParts[0]
        const downstreamPort = hostParts[1] ?? "8080"
        // Derive account service address from the destination
        // If destination is "envoy:8080", account service would be "account.envoy:8080"
        // In the test environment, the account service is at "account:8080"
        // For production with envoy, it's at the same port as envoy
        const accountServiceAddr = `https://account.${downstreamHost}:${downstreamPort}`

        deductionClient.scheduleExternalDeduction({
          externalRequestId,
          userId,
          feedbackServiceAddress: accountServiceAddr,
          delaySeconds: config.deductionDelaySeconds,
        }).catch((err: unknown) => {
          console.error("schedule external deduction error:", err)
        })
      }
    }

    // Build the forwarded request
    const method = c.req.method
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
    const headers = new Headers(c.req.raw.headers)

    // Remove hop-by-hop headers
    headers.delete("host")
    headers.delete("proxy-connection")
    headers.delete("transfer-encoding")
    headers.delete("connection")

    // Set external request ID
    headers.set("x-external-request-id", externalRequestId)

    // Force HTTPS unless explicitly running in insecure mode.
    let targetUrl = fullUrl
    if (u.protocol === "http:" && !config.insecure) {
      targetUrl = new URL(`https://${u.host}${path}`).href
    }

    // Obtain a cashier-bound DPoP when configured.
    if (config.cashierAddress) {
      const principal = c.req.header("x-user-id")
      if (!principal) return c.text("Unauthorized: missing x-user-id", 401)
      try {
        const response = await fetch(new URL("/cashier.v1.CashierService/GetAccessToken", config.cashierAddress), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-request-id": externalRequestId,
            "x-user-id": principal,
          },
          body: JSON.stringify({ htu: targetUrl.split("?")[0], htm: method, preferredPaymentCoin: 1, preferredPaymentEnvironment: 2 }),
        })
        if (!response.ok) {
          return c.text(`Cashier access token request failed: ${response.status}`, 502)
        }
        const payload = await response.json() as { accessToken?: string }
        if (!payload.accessToken) return c.text("Cashier returned no access token", 502)
        headers.set("Authorization", `Bearer ${payload.accessToken}`)
      } catch (error) {
        console.error("cashier error:", error)
        return c.text("Bad Gateway: cashier unavailable", 502)
      }
    }

    // Direct mode derives a P-256 key from the outproxy master secret.
    if (!headers.has("Authorization") && config.dpopMasterSecret) {
      const seed = sha256(new TextEncoder().encode("direct"), new TextEncoder().encode(config.dpopMasterSecret))
      const derivedKeypair = await importP256Seed(seed)
      const htu = new URL(targetUrl)
      htu.search = ""
      htu.hash = ""
      const proof = await dpop.generateProof(derivedKeypair, htu.href.replace(/\/$/, ""), method)
      headers.set("Authorization", `Bearer ${proof}`)
    }

    // Legacy explicit JWK mode remains available only when no derivation mode is configured.
    if (!headers.has("Authorization") && keypair) {
      const htu = new URL(targetUrl)
      htu.search = ""
      htu.hash = ""
      const proof = await dpop.generateProof(keypair, htu.href.replace(/\/$/, ""), method)
      headers.set("Authorization", `Bearer ${proof}`)
    }

    // Forward the request to the real destination
    try {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
        // Don't use proxy for the forwarded request itself
        proxy: undefined,
      })

      const responseBody = await response.arrayBuffer()
      const responseHeaders = new Headers(response.headers)
      // Bun's fetch decompresses gzip when reading arrayBuffer, so remove Content-Encoding
      responseHeaders.delete('content-encoding')
      return new Response(responseBody, { status: response.status, headers: responseHeaders })
    } catch (err) {
      console.error(`proxy error for ${destination}${path}:`, err)
      return c.text("Bad Gateway", 502)
    }
  })

  return app
}

export async function main(overrideConfig?: Config) {
  const app = await createApp(overrideConfig)
  const port = Number((overrideConfig?.listenAddr ?? loadConfig().listenAddr).split(":").pop() ?? 9090)
  Bun.serve({ port, fetch: app.fetch })
}

main().catch((err) => {
  console.error("outproxy fatal:", err)
  process.exit(1)
})
