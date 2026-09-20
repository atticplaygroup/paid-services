import { describe, expect, it } from "bun:test"
import { p256 } from "@noble/curves/nist.js"
import * as dpop from "dpop"

const seed = new Uint8Array(32).fill(7)

function sha256(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const input of inputs) hash.update(input)
  return new Uint8Array(hash.digest())
}

function base64Url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
  return Uint8Array.fromBase64(padded)
}

function jwkFromSeed(seed: Uint8Array) {
  const publicKey = p256.getPublicKey(seed, false)
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("invalid P-256 public key")
  return {
    crv: "P-256",
    d: base64Url(seed),
    kty: "EC",
    x: base64Url(publicKey.slice(1, 33)),
    y: base64Url(publicKey.slice(33)),
  }
}

async function importSeed(seed: Uint8Array): Promise<dpop.KeyPair> {
  const jwk = jwkFromSeed(seed)
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    crypto.subtle.importKey("jwk", { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  ])
  return { privateKey, publicKey }
}

async function proofJwk(proof: string): Promise<Record<string, string>> {
  const [encodedHeader, encodedPayload, encodedSignature] = proof.split(".")
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedHeader)))
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    header.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64UrlDecode(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  )
  if (!verified) throw new Error("invalid DPoP signature")
  return header.jwk
}

describe("outproxy direct and cashier modes", () => {
  it("derives a valid P-256 key for direct mode", async () => {
    const derived = sha256(new TextEncoder().encode("direct"), seed)
    const keypair = await importSeed(derived)
    const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
    expect(jwk.kty).toBe("EC")
    expect(jwk.crv).toBe("P-256")
    expect(jwk.x).not.toBe(jwk.y)
  })

  it("generates a DPoP proof with the derived P-256 key", async () => {
    const derived = sha256(new TextEncoder().encode("cashier"), seed)
    const keypair = await importSeed(derived)
    const proof = await dpop.generateProof(keypair, "https://provider.example/path", "GET")
    expect(proof.split(".")).toHaveLength(3)
    expect(JSON.parse(atob(proof.split(".")[0]))).toEqual(expect.objectContaining({ alg: "ES256", typ: "dpop+jwt" }))
  })

  it("uses sha256(direct || master secret) in direct mode", async () => {
    const { createApp: main } = await import("./server.js")
    const derived = sha256(new TextEncoder().encode("direct"), new TextEncoder().encode("master-secret"))
    const expected = await importSeed(derived)
    const expectedJwk = await crypto.subtle.exportKey("jwk", expected.publicKey)
    const originalFetch = globalThis.fetch
    let proof: string | undefined
    globalThis.fetch = async (_input, init) => {
      proof = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "")
      return new Response("proxied", { status: 200 })
    }
    try {
      const app = await main({
        listenAddr: ":9090",
        dpopMasterSecret: "master-secret",
        insecure: true,
        alsAddress: undefined,
        scheduleEnabled: false,
        deductionDelaySeconds: 0,
      })
      const response = await app.request("http://provider.example/path", { method: "POST", body: "payload" })
      expect(response.status).toBe(200)
      expect(await proofJwk(proof!)).toEqual({ crv: "P-256", kty: "EC", x: expectedJwk.x, y: expectedJwk.y })
      const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(proof!.split(".")[1])))
      expect(claims.htm).toBe("POST")
      expect(claims.htu).toBe("http://provider.example/path")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("uses sha256(cashier || master secret) in cashier mode", async () => {
    const derived = sha256(new TextEncoder().encode("cashier"), new TextEncoder().encode("master-secret"))
    const expected = await importSeed(derived)
    const expectedJwk = await crypto.subtle.exportKey("jwk", expected.publicKey)
    const htu = "http://cashier:9090/cashier.v1.CashierService/GetAccessToken"
    const proof = await dpop.generateProof(expected, htu, "POST")
    expect(await proofJwk(proof)).toEqual({ crv: "P-256", kty: "EC", x: expectedJwk.x, y: expectedJwk.y })
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(proof.split(".")[1])))
    expect(claims.htm).toBe("POST")
    expect(claims.htu).toBe(htu)
  })
})

describe("outproxy cashier integration", () => {
  it("fetches the cashier DPoP and forwards it as the bearer token", async () => {
    const { createApp: main } = await import("./server.js")
    const app = await main({
      listenAddr: ":9090",
      cashierAddress: "http://cashier:9090",
      insecure: true,
      alsAddress: undefined,
      scheduleEnabled: false,
      deductionDelaySeconds: 0,
    })
    const target = new Response("proxied", { status: 200, headers: { "x-forwarded": "yes" } })
    const originalFetch = globalThis.fetch
    let cashierBody: unknown
    let bearer: string | null | undefined
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url === "http://cashier:9090/cashier.v1.CashierService/GetAccessToken") {
        cashierBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ accessToken: "cashier-dpop" }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url === "http://provider.example/path") {
        bearer = new Headers(init?.headers).get("authorization")
        return target
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch
    try {
      const response = await app.request("http://provider.example/path", {
        method: "POST",
        headers: { "x-user-id": "alice" },
        body: "payload",
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("proxied")
      expect(cashierBody).toEqual({ htu: "http://provider.example/path", htm: "POST", preferredPaymentCoin: 1, preferredPaymentEnvironment: 2 })
      expect(bearer).toBe("Bearer cashier-dpop")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("rejects cashier mode without a trusted principal", async () => {
    const { createApp: main } = await import("./server.js")
    const app = await main({
      listenAddr: ":9090",
      cashierAddress: "http://cashier:9090",
      insecure: true,
      alsAddress: undefined,
      scheduleEnabled: false,
      deductionDelaySeconds: 0,
    })
    const response = await app.request("http://provider.example/path", { method: "GET" })
    expect(response.status).toBe(401)
  })
})
