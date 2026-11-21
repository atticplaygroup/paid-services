import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import * as json from "multiformats/codecs/json"
import type { Functionality } from "../../router/src/lib.ts"
export type { Functionality }
export const rendering = { behavior: { name: "papp-render", maintainer: "paid", tag: "v1" }, variant: { name: "papp-render", maintainer: "paid", tag: "v1" } }
export const budget = { behavior: { name: "papp-budget", maintainer: "paid", tag: "v1" }, variant: { name: "papp-budget", maintainer: "paid", tag: "v1" } }
export interface PappManifest { name: string; proposer: string; functionality: Functionality; version: number; webpage: string; signature: string }
export async function pappId(name: string, proposer: string) {
  if (!name || !proposer) throw new Error("pApp name and proposer required")
  return CID.createV1(json.code, await sha256.digest(json.encode([name, proposer]))).toString()
}
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
export async function proposerPrincipal(jwk: JsonWebKey) {
  return CID.createV1(0xeb51, await sha256.digest(new TextEncoder().encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))).toString()
}
export async function verifyManifest(manifest: PappManifest, id: string) {
  if (await pappId(manifest.name, manifest.proposer) !== id) throw new Error("pApp identity mismatch")
  const { signature, ...unsigned } = manifest
  const [header, payload, sig, extra] = signature.split(".")
  if (!sig || extra) throw new Error("invalid manifest signature")
  const h = JSON.parse(new TextDecoder().decode(decode(header)))
  const jwk = h.jwk
  if (h.alg !== "ES256" || jwk?.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) throw new Error("invalid manifest signer")
  const principal = await proposerPrincipal(jwk)
  if (principal !== manifest.proposer || new TextDecoder().decode(decode(payload)) !== JSON.stringify(unsigned)) throw new Error("manifest signer or payload mismatch")
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(sig), new TextEncoder().encode(`${header}.${payload}`))) throw new Error("invalid manifest signature")
  const page = new URL(manifest.webpage)
  if (page.protocol !== "ipfs:") throw new Error("pApp webpage must be immutable IPFS content")
  CID.parse(page.hostname)
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) throw new Error("invalid release version")
  return manifest
}
