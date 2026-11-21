import { proposerPrincipal, type Functionality } from "./manifest.ts"

// Same fixed-width UTC timestamp format as mysql-proposer's date +%Y%m%d%H%M%S%N.
export function releaseTag(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, "") + "000000"
}
export function variantKey(functionality: Functionality) {
  const variant = functionality.variant
  if (!variant?.name || !variant.maintainer || !/^\d{23}$/.test(variant.tag ?? "")) throw new Error("pApp release tag must be a 23-digit UTC timestamp")
  return `papp/variants/${variant.name}/${variant.tag}`
}
export interface ReleaseVariant { owner: string; key: string; cid: string; revision: string; ownerJwk: string; signature: string }
const encode = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
const utf8 = new TextEncoder()
function payload(anchor: ReleaseVariant) {
  return JSON.stringify({ cid: anchor.cid, key: anchor.key, owner: anchor.owner, revision: Number(anchor.revision), v: "paid.meter.anchor.v1" })
}
export async function signReleaseVariant(key: CryptoKeyPair, functionality: Functionality, cid: string): Promise<ReleaseVariant> {
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey)
  delete jwk.key_ops; delete jwk.ext
  const anchor = { owner: await proposerPrincipal(jwk), key: variantKey(functionality), cid, revision: String(Date.now()), ownerJwk: JSON.stringify(jwk), signature: "" }
  if (anchor.owner !== functionality.variant?.maintainer) throw new Error("variant signer must be its maintainer")
  const input = encode(utf8.encode(JSON.stringify({ alg: "ES256", typ: "JWT" }))) + "." + encode(utf8.encode(payload(anchor)))
  anchor.signature = input + "." + encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, utf8.encode(input))))
  return anchor
}
export async function verifyReleaseVariant(anchor: ReleaseVariant, functionality: Functionality) {
  if (anchor.owner !== functionality.variant?.maintainer || anchor.key !== variantKey(functionality)) throw new Error("release variant identity mismatch")
  if (!Number.isSafeInteger(Number(anchor.revision)) || Number(anchor.revision) <= 0) throw new Error("invalid variant revision")
  const jwk = JSON.parse(anchor.ownerJwk)
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d || await proposerPrincipal(jwk) !== anchor.owner) throw new Error("invalid variant signer")
  const [header, body, signature, extra] = anchor.signature.split(".")
  if (!signature || extra || JSON.parse(new TextDecoder().decode(decode(header))).alg !== "ES256" || new TextDecoder().decode(decode(body)) !== payload(anchor)) throw new Error("invalid variant payload")
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(signature), utf8.encode(`${header}.${body}`))) throw new Error("invalid variant signature")
  return anchor.cid
}
