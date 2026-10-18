import { p256 } from "@noble/curves/nist.js"
import * as dpop from "dpop"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"

export function sha256(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const rawInput of inputs) hash.update(rawInput)
  return new Uint8Array(hash.digest().buffer as ArrayBuffer, hash.digest().byteOffset, hash.digest().byteLength)
}

export function bytesToHex(input: Uint8Array): string {
  return Array.from(input, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function base64UrlNoPadding(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  return Uint8Array.fromBase64(normalized + "=".repeat((4 - normalized.length % 4) % 4)) as Uint8Array<ArrayBuffer>
}

export function providerId(thumbprint: Uint8Array): string {
  if (thumbprint.length !== 32) throw new Error("provider thumbprint must be 32 bytes")
  return CID.create(1, 0xeb51, createDigest(0x12, thumbprint)).toString()
}

export async function importDpopSeed(seed: Uint8Array): Promise<dpop.KeyPair> {
  if (seed.length !== 32) throw new Error("dpop seed must be 32 bytes")
  const publicKeyBytes = p256.getPublicKey(seed, false)
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) throw new Error("invalid P-256 public key")
  const privateJwk = {
    crv: "P-256",
    d: base64UrlNoPadding(seed),
    kty: "EC",
    x: base64UrlNoPadding(publicKeyBytes.slice(1, 33)),
    y: base64UrlNoPadding(publicKeyBytes.slice(33)),
  }
  const publicJwk = { crv: "P-256", kty: "EC", x: privateJwk.x, y: privateJwk.y }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  ])
  return { privateKey, publicKey }
}

export function importDpopKeyPair(keypair: dpop.KeyPair): CryptoKeyPair {
  return keypair
}

export function dpopSeed(accountSalt: Uint8Array, masterSecret: Uint8Array, hostname: string): Uint8Array {
  return sha256(accountSalt, masterSecret, new TextEncoder().encode(hostname))
}

export function thumbprintFromJwk(jwk: { crv?: string; kty?: string; x?: string; y?: string }): Uint8Array {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("invalid P-256 JWK")
  return sha256(new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
}

export function normalizeHtu(value: string): string {
  const url = new URL(value)
  url.search = ""
  url.hash = ""
  return url.href.replace(/\/$/, "")
}
