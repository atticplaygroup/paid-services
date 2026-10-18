import { createClient } from "@connectrpc/connect"
import type { Client, Transport } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import {
  MeteredStorageService,
  StorageBackend,
  Codec,
  type Anchor,
} from "../proto/gen/es/kvstore/v1/kvstore_pb.js"
import { CID } from "multiformats/cid"
import { create } from "multiformats/hashes/digest"
import { generateProof } from "dpop"
import { AsyncLocalStorage } from "node:async_hooks"
import type { Interceptor } from "@connectrpc/connect"

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface OutgoingRequestIdentity {
  requestId?: string
  externalRequestId?: string
}

const requestIdentityStorage = new AsyncLocalStorage<OutgoingRequestIdentity>()

export function withRequestIdentity<T>(identity: OutgoingRequestIdentity, callback: () => Promise<T>): Promise<T> {
  return requestIdentityStorage.run(identity, callback)
}

function requestIdentityInterceptor(): Interceptor {
  return (next) => async (request) => {
    const identity = requestIdentityStorage.getStore()
    if (identity?.requestId) request.header.set("x-request-id", identity.requestId)
    if (identity?.externalRequestId) request.header.set("x-external-request-id", identity.externalRequestId)
    return next(request)
  }
}

function createDpopFetch(baseUrl: string, keypair: CryptoKeyPair): FetchFn {
  return async (input, init) => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url)
    const u = new URL(url, baseUrl)
    u.search = ""
    u.hash = ""
    const htu = u.href.replace(/\/$/, "")
    const method = (init?.method ?? "POST").toUpperCase()
    const proof = await generateProof(keypair, htu, method)
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${proof}`)
    return globalThis.fetch(input, { ...init, headers })
  }
}

export function createProxiedFetch(outproxyAddress: string): FetchFn {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    return globalThis.fetch(input, { ...init, headers, proxy: outproxyAddress } as any)
  }
}

export async function principalFromJwk(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return CID.create(1, 0xeb51, create(0x12, digest)).toString()
}

export class KvstoreClient {
  private baseUrl: string
  private dpopKeypair?: CryptoKeyPair
  private outproxyAddress?: string
  private lastAnchor?: Anchor

  constructor(baseUrl: string, dpopKeypair?: CryptoKeyPair, outproxyAddress?: string, private fetchOverride?: FetchFn) {
    this.baseUrl = baseUrl
    this.dpopKeypair = dpopKeypair
    this.outproxyAddress = outproxyAddress
  }

  private createClient(): Client<typeof MeteredStorageService> {
    const transportOptions: any = {
      baseUrl: this.baseUrl,
      useBinaryFormat: true,
      fetch: this.fetchOverride,
      interceptors: [requestIdentityInterceptor()],
    }
    if (this.fetchOverride) {
      transportOptions.fetch = this.fetchOverride
    } else if (this.outproxyAddress) {
      transportOptions.fetch = createProxiedFetch(this.outproxyAddress)
    } else if (this.dpopKeypair) {
      transportOptions.fetch = createDpopFetch(this.baseUrl, this.dpopKeypair)
    }
    const transport: Transport = createConnectTransport(transportOptions)
    return createClient(MeteredStorageService, transport)
  }

  sha256ToCid(digest: string): string {
    const hex = digest.replace(/^sha256:/, "")
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
    const mhDigest = create(0x12, bytes)
    return CID.create(1, 0x55, mhDigest).toString()
  }

  async getBlob(digest: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const key = this.sha256ToCid(digest)
    try {
      const res = await this.createClient().getCASValue({ key })
      return new Uint8Array(res.value) as Uint8Array<ArrayBuffer>
    } catch { return null }
  }

  async putBlob(digest: string, value: Uint8Array): Promise<void> {
    const key = this.sha256ToCid(digest)
    await this.createClient().createCASValue({
      storageBackend: StorageBackend.BLOB_STORAGE,
      codec: Codec.RAW,
      key,
      ttl: { seconds: BigInt(86400 * 30), nanos: 0 },
      value,
    })
  }

  async putManifestTag(name: string, tag: string, body: Uint8Array<ArrayBuffer>, revision: number, anchorRevision?: number): Promise<void> {
    const key = `oci/manifests/${name}/${tag}`
    const cid = this.sha256ToCid(`sha256:${await digestOf(body)}`)
    const anchor = await this.signAnchor({ key, cid, revision: BigInt(anchorRevision ?? revision) })
    await this.createClient().createProtectedValueAnchor({ anchor })
  }

  async getManifestTag(name: string, tag: string, owner: string): Promise<Uint8Array<ArrayBuffer> | null> {
    try {
      const res = await this.createClient().getProtectedValueAnchor({ owner, key: `oci/manifests/${name}/${tag}` })
      const anchor = res.anchor as Anchor
      await this.verifyAnchor(anchor, owner, `oci/manifests/${name}/${tag}`)
      const content = await this.getBlob(`sha256:${cidToDigestHex(anchor.cid)}`)
      if (!content) return null
      if (this.sha256ToCid(`sha256:${await digestOf(content)}`) !== anchor.cid) return null
      return content
    } catch { return null }
  }

  private async signAnchor(input: { key: string; cid: string; revision: bigint }): Promise<Anchor> {
    if (!this.dpopKeypair) throw new Error("DPOP_PRIVATE_KEY is required to sign protected value anchors")
    const ownerJwk = await crypto.subtle.exportKey("jwk", this.dpopKeypair.publicKey)
    delete ownerJwk.key_ops
    delete ownerJwk.ext
    const owner = await principalFromJwk(ownerJwk)
    const payload = { owner, key: input.key, cid: input.cid, revision: Number(input.revision), v: "paid.meter.anchor.v1" }
    const canonical = JSON.stringify(payload, Object.keys(payload).sort())
    const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT" })))
    const encodedPayload = encodeBase64Url(new TextEncoder().encode(canonical))
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.dpopKeypair.privateKey,
      encodeSigningInput(`${header}.${encodedPayload}`),
    )
    const anchor = {
      owner,
      key: input.key,
      cid: input.cid,
      revision: input.revision,
      ownerJwk: JSON.stringify(ownerJwk),
      signature: `${header}.${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`,
    } as Anchor
    this.lastAnchor = anchor
    return anchor
  }

  private async verifyAnchor(anchor: Anchor, owner?: string, key?: string): Promise<void> {
    if (owner !== undefined && anchor.owner !== owner) throw new Error("anchor owner mismatch")
    if (key !== undefined && anchor.key !== key) throw new Error("anchor key mismatch")
    const parts = anchor.signature.split(".")
    if (parts.length !== 3) throw new Error("invalid anchor signature")
    const jwk = JSON.parse(anchor.ownerJwk)
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) throw new Error("invalid owner JWK")
    if (await principalFromJwk(jwk) !== anchor.owner) throw new Error("anchor signer mismatch")
    const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"])
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      decodeBase64UrlBytes(parts[2]),
      encodeSigningInput(`${parts[0]}.${parts[1]}`),
    )
    if (!valid) throw new Error("invalid anchor signature")
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64UrlBytes(parts[1])))
    const expected = {
      owner: anchor.owner,
      key: anchor.key,
      cid: anchor.cid,
      revision: Number(anchor.revision),
      v: "paid.meter.anchor.v1",
    }
    if (JSON.stringify(payload, Object.keys(expected).sort()) !== JSON.stringify(expected, Object.keys(expected).sort())) {
      throw new Error("anchor payload mismatch")
    }
  }

  async listTags(name: string, owner: string): Promise<{ name: string; tags: string[] }> {
    try {
      const res = await this.createClient().getProtectedValueAnchor({ owner, key: `oci/tags/${name}` })
      const anchor = res.anchor as Anchor
      await this.verifyAnchor(anchor, owner, `oci/tags/${name}`)
      const content = await this.getBlob(`sha256:${cidToDigestHex(anchor.cid)}`)
      if (!content) return { name, tags: [] }
      const tags = JSON.parse(new TextDecoder().decode(content))
      return { name, tags: Array.isArray(tags) ? tags : [] }
    } catch {
      return { name, tags: [] }
    }
  }

  async putTagList(name: string, tags: string[]): Promise<void> {
    const key = `oci/tags/${name}`
    const value = new TextEncoder().encode(JSON.stringify(tags))
    const digest = `sha256:${await digestOf(value)}`
    await this.putBlob(digest, value)
    const anchor = await this.signAnchor({ key, cid: this.sha256ToCid(digest), revision: BigInt(Date.now()) })
    await this.createClient().createProtectedValueAnchor({ anchor })
  }
}

async function digestOf(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", value))
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function cidToDigestHex(cidString: string): string {
  return Array.from(CID.parse(cidString).multihash.digest).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function encodeSigningInput(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value)
  const output = new Uint8Array(bytes.length)
  output.set(bytes)
  return output
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeBase64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
