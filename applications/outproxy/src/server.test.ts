import { describe, expect, it } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rootCertificates } from "node:tls"
import * as forge from "node-forge"
import { p256 } from "@noble/curves/nist.js"
import * as dpop from "dpop"
import { deriveCashierPrincipal } from "./identity.js"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"

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

const TEST_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow"

const CASHIER_ACCOUNT_SALT = "cashier"
const CASHIER_PRINCIPAL = "bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s"
const CUSTOMER_PRINCIPAL = "bahi5maysecprehf65zwimg5rsg2orul6m2tfvxgcpllkvr6lmm6ihbe4p35wu"
const REQUEST_ID = crypto.randomUUID()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
    const { createApp } = await import("./server.js")
    const derived = sha256(new TextEncoder().encode("direct"), new TextEncoder().encode(TEST_MNEMONIC))
    const expected = await importSeed(derived)
    const expectedJwk = await crypto.subtle.exportKey("jwk", expected.publicKey)
    let proof: string | undefined
    const fetchFn = async (input, init) => {
      proof = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "")
      return new Response("proxied", { status: 200 })
    }
    const app = await createApp({ listenAddr: ":9090", dpopMasterSecret: TEST_MNEMONIC, fetchFn: fetchFn as typeof fetch })
    const response = await app.request("http://provider.example/path", { method: "POST", body: "payload" })
    expect(response.status).toBe(200)
    expect(await proofJwk(proof!)).toEqual({ crv: "P-256", kty: "EC", x: expectedJwk.x, y: expectedJwk.y })
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(proof!.split(".")[1])))
    expect(claims.htm).toBe("POST")
    expect(claims.htu).toBe("http://provider.example/path")
  })

  it("derives cashier principals from the salted P-256 public JWK", async () => {
    const keypair = await importSeed(sha256(new TextEncoder().encode(CASHIER_ACCOUNT_SALT), new TextEncoder().encode(TEST_MNEMONIC)))
    const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
    const digest = sha256(new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
    const expected = CID.createV1(0xeb51, createDigest(0x12, digest)).toString()
    expect(expected).toBe(CASHIER_PRINCIPAL)
    expect(await deriveCashierPrincipal(TEST_MNEMONIC, CASHIER_ACCOUNT_SALT)).toBe(expected)
    expect(await deriveCashierPrincipal(TEST_MNEMONIC, "other-cashier")).not.toBe(expected)
    expect(await deriveCashierPrincipal("test test test test test test test test test test test junk", CASHIER_ACCOUNT_SALT)).not.toBe(expected)
  })
})

describe("outproxy identity boundaries", () => {
  it("preserves client identity headers while injecting service identity", async () => {
    const { createApp } = await import("./server.js")
    let headers: Headers | undefined
    let body: string | undefined
    const fetchFn = (async (_input, init) => {
      headers = new Headers(init?.headers)
      body = new TextDecoder().decode(init?.body as Uint8Array)
      return new Response("proxied", { status: 200 })
    }) as typeof fetch
    const app = await createApp({
      listenAddr: ":9090",
      dpopMasterSecret: TEST_MNEMONIC,
      fetchFn,
    })
    const response = await app.request("http://provider.example/path", {
      method: "POST",
      headers: {
        authorization: "Bearer customer-token",
        "x-user-id": CUSTOMER_PRINCIPAL,
        "x-request-id": REQUEST_ID,
        "x-external-request-id": "external",
      },
      body: "unchanged",
    })

    expect(response.status).toBe(200)
    expect(headers!.get("authorization")).toMatch(/^Bearer (?!customer-token$)/)
    expect(headers!.get("x-user-id")).toBe(CUSTOMER_PRINCIPAL)
    expect(headers!.get("x-request-id")).toBe(REQUEST_ID)
    expect(body).toBe("unchanged")
  })

  it("preserves non-service-identity headers and injects only authorization", async () => {
    const { createApp } = await import("./server.js")
    let cashierHeaders: Headers | undefined
    let upstreamHeaders: Headers | undefined
    const fetchFn = (async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      const headers = new Headers(init?.headers)
      if (url === "http://cashier:9090/cashier.v1.CashierService/GetAccessToken") {
        cashierHeaders = headers
        return new Response(JSON.stringify({ accessToken: "cashier-dpop" }), { status: 200 })
      }
      if (url === "http://provider.example/path") {
        upstreamHeaders = headers
        return new Response("proxied", { status: 200 })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch
    const app = await createApp({
      listenAddr: ":9090",
      cashierAddress: "http://cashier:9090",
      dpopMasterSecret: TEST_MNEMONIC,
      cashierAccountSalt: CASHIER_ACCOUNT_SALT,
      fetchFn,
    })
    const response = await app.request("http://provider.example/path", {
      method: "POST",
      headers: {
        authorization: "Bearer customer-token",
        "x-user-id": CUSTOMER_PRINCIPAL,
        "x-request-id": REQUEST_ID,
        "x-external-request-id": "external",
        "x-custom-header": "custom",
      },
      body: "payload",
    })

    expect(response.status).toBe(200)
    expect(cashierHeaders!.get("x-user-id")).toBe(CASHIER_PRINCIPAL)
    expect(cashierHeaders!.get("x-request-id")).toBe(REQUEST_ID)
    expect(cashierHeaders!.get("x-external-request-id")).toBe("external")
    expect(upstreamHeaders!.get("x-user-id")).toBe(CUSTOMER_PRINCIPAL)
    expect(upstreamHeaders!.get("x-request-id")).toBe(REQUEST_ID)
    expect(upstreamHeaders!.get("x-custom-header")).toBe("custom")
    expect(upstreamHeaders!.get("authorization")).toBe("Bearer cashier-dpop")
  })

  it("does not add x-external-request-id", async () => {
    const { createApp } = await import("./server.js")
    let headers: Headers | undefined
    const fetchFn = (async (_input, init) => {
      headers = new Headers(init?.headers)
      return new Response("proxied", { status: 200 })
    }) as typeof fetch
    const app = await createApp({ listenAddr: ":9090", dpopMasterSecret: TEST_MNEMONIC, fetchFn })
    const response = await app.request("http://provider.example/path", { method: "GET", headers: { "x-external-request-id": "external" } })

    expect(response.status).toBe(200)
    expect(headers!.get("x-external-request-id")).toBe("external")
  })
})

describe("outproxy cashier integration", () => {
  it("injects fixed-key proofs without adding x-user-id", async () => {
    const { createApp } = await import("./server.js")
    let userId: string | null | undefined
    let authorization: string | null | undefined
    const fetchFn = (async (_input, init) => {
      const headers = new Headers(init?.headers)
      userId = headers.get("x-user-id")
      authorization = headers.get("authorization")
      return new Response("proxied", { status: 200 })
    }) as typeof fetch
    const app = await createApp({
      listenAddr: ":9090",
      dpopMasterSecret: TEST_MNEMONIC,
      fetchFn,
    })
    const response = await app.request("http://provider.example/path", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("proxied")
    expect(authorization).toMatch(/^Bearer /)
    expect(userId).toBeNull()
    expect(await proofJwk(authorization!.slice(7))).toEqual(expect.objectContaining({ crv: "P-256", kty: "EC" }))
  })

  it("fetches the cashier DPoP and injects it without identity headers", async () => {
    const { createApp } = await import("./server.js")
    const target = new Response("proxied", { status: 200, headers: { "x-forwarded": "yes" } })
    let cashierBody: unknown
    let bearer: string | null | undefined
    let upstreamHeaders: Headers | undefined
    const fetchFn = (async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url === "http://cashier:9090/cashier.v1.CashierService/GetAccessToken") {
        const headers = new Headers(init?.headers)
        expect(headers.get("x-user-id")).toBe(CASHIER_PRINCIPAL)
        expect(headers.get("x-request-id")).toMatch(UUID_PATTERN)
        cashierBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({ accessToken: "cashier-dpop" }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url === "http://provider.example/path") {
        upstreamHeaders = new Headers(init?.headers)
        bearer = new Headers(init?.headers).get("authorization")
        return target
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as typeof fetch
    const app = await createApp({
      listenAddr: ":9090",
      cashierAddress: "http://cashier:9090",
      dpopMasterSecret: TEST_MNEMONIC,
      cashierAccountSalt: CASHIER_ACCOUNT_SALT,
      fetchFn,
    })
    const response = await app.request("http://provider.example/path", {
      method: "POST",
      headers: { "x-custom-header": "custom" },
      body: "payload",
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("proxied")
    expect(cashierBody).toEqual({ htu: "http://provider.example/path", htm: "POST", preferredPaymentCoin: 1, preferredPaymentEnvironment: 2 })
    expect(bearer).toBe("Bearer cashier-dpop")
    expect(upstreamHeaders!.get("x-custom-header")).toBe("custom")
    expect(upstreamHeaders!.get("x-user-id")).toBeNull()
    expect(upstreamHeaders!.get("x-request-id")).toBeNull()
    expect(upstreamHeaders!.get("authorization")).toBe("Bearer cashier-dpop")
  })
  it.each([
    { failure: "http", message: "Cashier access token request failed: 403" },
    { failure: "empty", message: "Cashier returned no access token" },
    { failure: "network", message: "Bad Gateway: cashier unavailable" },
  ])("does not forward when cashier token acquisition fails: %j", async ({ failure, message }) => {
    const { createApp } = await import("./server.js")
    let requests = 0
    const fetchFn = (async (input) => {
      requests++
      expect(String(input)).toBe("http://cashier:9090/cashier.v1.CashierService/GetAccessToken")
      if (failure === "network") throw new Error("connection refused")
      return failure === "http" ? new Response("forbidden", { status: 403 }) : Response.json({})
    }) as typeof fetch
    const app = await createApp({
      listenAddr: ":9090",
      dpopMasterSecret: TEST_MNEMONIC,
      cashierAddress: "http://cashier:9090",
      cashierAccountSalt: CASHIER_ACCOUNT_SALT,
      fetchFn,
    })
    const response = await app.request("http://provider.example/path")
    expect(response.status).toBe(502)
    expect(await response.text()).toBe(message)
    expect(requests).toBe(1)
  })

  it.each([
    { cashierAddress: undefined, dpopMasterSecret: "", cashierAccountSalt: undefined, error: "DPOP_MASTER_SECRET is required" },
    { cashierAddress: "http://cashier:9090", dpopMasterSecret: "", cashierAccountSalt: CASHIER_ACCOUNT_SALT, error: "DPOP_MASTER_SECRET is required" },
    { cashierAddress: "http://cashier:9090", dpopMasterSecret: TEST_MNEMONIC, cashierAccountSalt: undefined, error: "CASHIER_ACCOUNT_SALT is required" },
    { cashierAddress: "http://cashier:9090", dpopMasterSecret: "invalid", cashierAccountSalt: CASHIER_ACCOUNT_SALT, error: "DPOP_MASTER_SECRET must be a BIP-39 mnemonic" },
  ])("rejects invalid identity configuration: %j", async ({ error, ...config }) => {
    const { createApp } = await import("./server.js")
    await expect(createApp({ listenAddr: ":9090", ...config })).rejects.toThrow(error)
  })

})

describe("outproxy on-the-fly TLS", () => {
  it("trusts a private HTTPS server while retaining public CA roots", async () => {
    const { createApp } = await import("./server.js")
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const certificate = forge.pki.createCertificate()
    certificate.publicKey = keys.publicKey
    certificate.serialNumber = "01"
    certificate.validity.notBefore = new Date(Date.now() - 60_000)
    certificate.validity.notAfter = new Date(Date.now() + 60_000)
    certificate.setSubject([{ name: "commonName", value: "localhost" }])
    certificate.setIssuer(certificate.subject.attributes)
    certificate.setExtensions([
      { name: "basicConstraints", critical: true, cA: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] },
    ])
    certificate.sign(keys.privateKey, forge.sha256.create())
    const pem = forge.pki.certificateToPem(certificate)
    const directory = mkdtempSync(join(tmpdir(), "outproxy-ca-"))
    const server = Bun.serve({
      hostname: "localhost", port: 0,
      tls: { cert: pem, key: forge.pki.privateKeyToPem(keys.privateKey) },
      fetch: () => new Response("private HTTPS"),
    })
    try {
      const caCertPath = join(directory, "ca.crt")
      await Bun.write(caCertPath, pem)
      let trustedCAs: string[] | undefined
      const app = await createApp({
        listenAddr: ":9090", dpopMasterSecret: TEST_MNEMONIC, caCertPath,
        fetchFn: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          trustedCAs = init?.tls?.ca as string[] | undefined
          return fetch(input, init)
        }, { preconnect: fetch.preconnect }),
      })
      const response = await app.request(server.url)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("private HTTPS")
      expect(trustedCAs).toContain(pem)
      expect(rootCertificates.length).toBeGreaterThan(0)
      for (const root of rootCertificates) expect(trustedCAs).toContain(root)
    } finally {
      server.stop(true)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("generates a CONNECT leaf certificate from an intermediate CA", async () => {
    const { createTlsLeafFactory } = await import("./server.js")
    const rootKeys = forge.pki.rsa.generateKeyPair(2048)
    const rootCertificate = forge.pki.createCertificate()
    rootCertificate.publicKey = rootKeys.publicKey
    rootCertificate.serialNumber = "01"
    rootCertificate.validity.notBefore = new Date(Date.now() - 60_000)
    rootCertificate.validity.notAfter = new Date(Date.now() + 60_000)
    rootCertificate.setSubject([{ name: "commonName", value: "test root" }])
    rootCertificate.setIssuer(rootCertificate.subject.attributes)
    rootCertificate.setExtensions([{ name: "basicConstraints", critical: true, cA: true }])
    rootCertificate.sign(rootKeys.privateKey, forge.sha256.create())

    const intermediateKeys = forge.pki.rsa.generateKeyPair(2048)
    const intermediateCertificate = forge.pki.createCertificate()
    intermediateCertificate.publicKey = intermediateKeys.publicKey
    intermediateCertificate.serialNumber = "02"
    intermediateCertificate.validity.notBefore = new Date(Date.now() - 60_000)
    intermediateCertificate.validity.notAfter = new Date(Date.now() + 60_000)
    intermediateCertificate.setSubject([{ name: "commonName", value: "test intermediate" }])
    intermediateCertificate.setIssuer(rootCertificate.subject.attributes)
    intermediateCertificate.setExtensions([
      { name: "basicConstraints", critical: true, cA: true },
      { name: "keyUsage", critical: true, keyCertSign: true },
    ])
    intermediateCertificate.sign(rootKeys.privateKey, forge.sha256.create())

    const createLeaf = createTlsLeafFactory({
      intermediateCertPem: forge.pki.certificateToPem(intermediateCertificate),
      intermediateKeyPem: forge.pki.privateKeyToPem(intermediateKeys.privateKey),
      caCertPem: forge.pki.certificateToPem(rootCertificate),
    })
    const first = await createLeaf("host.example:443")
    const second = await createLeaf("other.example:443")
    const firstLeaf = new X509Certificate(first.cert!)
    const pemIntermediate = forge.pki.certificateToPem(intermediateCertificate)
    expect(first.key).toMatch(/BEGIN RSA PRIVATE KEY/)
    expect(first.cert?.split("-----BEGIN CERTIFICATE-----")).toHaveLength(3)
    expect(firstLeaf.checkIssued(new X509Certificate(pemIntermediate))).toBe(true)
    expect(firstLeaf.subjectAltName).toContain("host.example")
    expect(new X509Certificate(second.cert!).subjectAltName).toContain("other.example")
  })
})
