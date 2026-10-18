import { AccessTokenError, CashierAccessTokenProvider, DirectAccessTokenProvider, type AccessTokenProvider } from "./access-token.js"
import { deriveCashierPrincipal, importMasterSecretSeed, importP256Seed } from "./identity.js"
export { importMasterSecretSeed } from "./identity.js"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { X509Certificate } from "node:crypto"
import { rootCertificates, TLSSocket, type SecureContextOptions } from "node:tls"
import * as forge from "node-forge"

interface Config {
  listenAddr: string
  tlsCertPath?: string
  tlsKeyPath?: string
  tlsCaCertPath?: string
  dpopMasterSecret: string
  cashierAddress?: string
  cashierAccountSalt?: string
  caCertPath?: string
  fetchFn?: typeof fetch
}

function loadConfig(): Config {
  return {
    listenAddr: process.env.LISTEN_ADDR ?? ":9090",
    tlsCertPath: process.env.TLS_CERT_PATH || undefined,
    tlsKeyPath: process.env.TLS_KEY_PATH || undefined,
    tlsCaCertPath: process.env.TLS_CA_CERT_PATH || undefined,
    dpopMasterSecret: process.env.DPOP_MASTER_SECRET ?? "",
    cashierAddress: process.env.CASHIER_ADDRESS || undefined,
    cashierAccountSalt: process.env.CASHIER_ACCOUNT_SALT || undefined,
    caCertPath: process.env.CA_CERT_PATH || undefined,
  }
}

export async function createApp(overrideConfig?: Config) {
  const config = overrideConfig ?? loadConfig()
  const doFetch = config.fetchFn ?? fetch
  if (!config.dpopMasterSecret) throw new Error("DPOP_MASTER_SECRET is required")
  const tokenProvider: AccessTokenProvider = config.cashierAddress
    ? new CashierAccessTokenProvider(config.cashierAddress, await deriveCashierPrincipal(config.dpopMasterSecret, config.cashierAccountSalt ?? ""), doFetch)
    : new DirectAccessTokenProvider(await importP256Seed(importMasterSecretSeed(config.dpopMasterSecret, "direct")))
  console.log(`outproxy starting on ${config.listenAddr}`)

  if (config.dpopMasterSecret) {
    console.log("DPoP key loaded from master secret")
  }

  const { Hono } = await import("hono")

  let trustedCertificates: string[] | undefined
  if (config.caCertPath) {
    // Explicit tls.ca replaces Bun's default roots, so include them as well.
    trustedCertificates = [...rootCertificates, await Bun.file(config.caCertPath).text()]
  }

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

    const targetUrl = fullUrl

    // Build the forwarded request
    const method = c.req.method
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
    const headers = new Headers(c.req.raw.headers)

    // Remove transport-only headers; application headers are forwarded unchanged.
    headers.delete("host")
    headers.delete("content-length")
    headers.delete("proxy-connection")
    headers.delete("proxy-authorization")
    headers.delete("te")
    headers.delete("trailer")
    headers.delete("transfer-encoding")
    headers.delete("upgrade")
    headers.delete("connection")

    try {
      const accessToken = await tokenProvider.getAccessToken({ url: targetUrl, method, headers })
      headers.set("Authorization", `Bearer ${accessToken}`)
    } catch (error) {
      if (error instanceof AccessTokenError) return c.text(error.message, 502)
      throw error
    }

    // Forward the request to the real destination
    try {
      const response = await doFetch(targetUrl, {
        method,
        headers,
        body: body as BodyInit | undefined,
        ...(u.protocol === "https:" && trustedCertificates ? { tls: { ca: trustedCertificates } } : {}),
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

export interface TlsLeafFactoryOptions {
  intermediateCertPem: string
  intermediateKeyPem: string
  caCertPem: string
}

export function createTlsLeafFactory({ intermediateCertPem, intermediateKeyPem, caCertPem }: TlsLeafFactoryOptions) {
  const intermediateKey = forge.pki.privateKeyFromPem(intermediateKeyPem)
  const intermediateCertificate = new X509Certificate(intermediateCertPem)
  const caCertificate = new X509Certificate(caCertPem)
  if (!intermediateCertificate.verify(caCertificate.publicKey)) {
    throw new Error("TLS_CERT_PATH must be certified by TLS_CA_CERT_PATH")
  }
  if (!intermediateCertificate.ca) {
    throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be an intermediate certificate authority")
  }

  const leafCache = new Map<string, { value: SecureContextOptions; expiresAt: number }>()
  return async (authority: string): Promise<SecureContextOptions> => {
    const hostname = authority.split(":", 1)[0]
    const cached = leafCache.get(hostname)
    if (cached && cached.expiresAt > Date.now()) return cached.value

    const keys = forge.pki.rsa.generateKeyPair(2048)
    const certificate = forge.pki.createCertificate()
    certificate.publicKey = keys.publicKey
    certificate.serialNumber = crypto.randomUUID().replaceAll("-", "")
    certificate.validity.notBefore = new Date(Date.now() - 60_000)
    certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000)
    certificate.setSubject([{ name: "commonName", value: hostname }])
    certificate.setIssuer(forge.pki.certificateFromPem(intermediateCertPem).subject.attributes)
    certificate.setExtensions([
      { name: "basicConstraints", critical: true, cA: false },
      { name: "keyUsage", critical: true, digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: hostname }] },
    ])
    certificate.sign(intermediateKey as forge.pki.rsa.PrivateKey, forge.sha256.create())
    const value = {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: `${forge.pki.certificateToPem(certificate)}\n${intermediateCertPem}`,
    }
    leafCache.set(hostname, { value, expiresAt: certificate.validity.notAfter.getTime() - 60_000 })
    return value
  }
}

export async function main(overrideConfig?: Config) {
  const config = overrideConfig ?? loadConfig()
  const app = await createApp(config)
  const port = Number(config.listenAddr.split(":").pop() ?? 9090)
  const intermediateCertPath = config.tlsCertPath
  const intermediateKeyPath = config.tlsKeyPath
  const caCertPath = config.tlsCaCertPath
  if (Boolean(intermediateCertPath) !== Boolean(intermediateKeyPath)) throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must be configured together")
  if (Boolean(intermediateCertPath) !== Boolean(caCertPath)) throw new Error("TLS_CA_CERT_PATH is required with the intermediate certificate")
  let leafFactory: ReturnType<typeof createTlsLeafFactory> | undefined
  if (intermediateCertPath && intermediateKeyPath && caCertPath) {
    leafFactory = createTlsLeafFactory({
      intermediateCertPem: await Bun.file(intermediateCertPath).text(),
      intermediateKeyPem: await Bun.file(intermediateKeyPath).text(),
      caCertPem: await Bun.file(caCertPath).text(),
    })
  }
  const getTlsContext = async (authority: string): Promise<SecureContextOptions> => {
    if (!leafFactory) throw new Error("TLS_CERT_PATH, TLS_KEY_PATH, and TLS_CA_CERT_PATH are required for CONNECT")
    return leafFactory(authority)
  }

  const forward = async (request: IncomingMessage, response: ServerResponse, authority?: string) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const scheme = authority ? "https" : "http"
    const url = request.url?.startsWith("http://") || request.url?.startsWith("https://")
      ? request.url
      : `${scheme}://${authority ?? request.headers.host}${request.url ?? "/"}`
    const method = request.method ?? "GET"
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks)
    const upstream = await app.fetch(new Request(url, { method, headers: request.headers as HeadersInit, body }))
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete("connection")
    responseHeaders.delete("keep-alive")
    responseHeaders.delete("proxy-connection")
    responseHeaders.delete("transfer-encoding")
    responseHeaders.delete("content-length")
    response.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()))
    response.end(Buffer.from(await upstream.arrayBuffer()))
  }

  const server = createServer((request, response) => void forward(request, response).catch((error) => {
    console.error("proxy request error:", error)
    response.writeHead(502).end("Bad Gateway")
  }))
  const tunneledServer = createServer((request, response) => {
    const authority = (request.socket as TLSSocket & { proxyAuthority?: string }).proxyAuthority
    void forward(request, response, authority).catch((error) => {
      console.error("proxy tunnel error:", error)
      response.writeHead(502).end("Bad Gateway")
    })
  })
  server.on("connect", async (request, socket, head) => {
    if (!leafFactory || !request.url) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")
      return
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) socket.unshift(head)
    const tlsContext = await getTlsContext(request.url)
    const tlsSocket = new TLSSocket(socket, { isServer: true, ...tlsContext }) as TLSSocket & { proxyAuthority?: string }
    tlsSocket.proxyAuthority = request.url
    tlsSocket.on("error", (error) => console.error("proxy TLS error:", error))
    tunneledServer.emit("connection", tlsSocket)
  })
  server.listen(port)
}

if (import.meta.main) main().catch((err) => {
  console.error("outproxy fatal:", err)
  process.exit(1)
})
