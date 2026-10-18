import * as dpop from "dpop"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { p256 } from "@noble/curves/nist.js"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"

function base64Url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

function sha256(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const input of inputs) hash.update(input)
  return new Uint8Array(hash.digest())
}

export async function importP256Seed(seed: Uint8Array): Promise<dpop.KeyPair> {
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

export function importMasterSecretSeed(masterSecret: string, domain: string): Uint8Array {
  const normalizedSecret = masterSecret.normalize("NFKD")
  if (!validateMnemonic(normalizedSecret, wordlist)) throw new Error("DPOP_MASTER_SECRET must be a BIP-39 mnemonic")
  return sha256(new TextEncoder().encode(domain), new TextEncoder().encode(normalizedSecret))
}

/** Derive the internal cashier account principal from the outproxy identity. */
export async function deriveCashierPrincipal(masterSecret: string, accountSalt: string): Promise<string> {
  if (!accountSalt) throw new Error("CASHIER_ACCOUNT_SALT is required for cashier mode")
  const keypair = await importP256Seed(importMasterSecretSeed(masterSecret, accountSalt))
  const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
  const thumbprint = sha256(new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
  return CID.createV1(0xeb51, createDigest(0x12, thumbprint)).toString()
}
