import { createIndexClient, fromJson, toJson, toJsonString, ProviderAdvertisementSchema, SignedAdvertisementSchema, SearchProviderRequestSchema, SearchProviderResponseSchema } from "../../applications/router/src/lib.ts"
import { generateProof } from "dpop"
import { createHash } from "node:crypto"
import { CID } from "multiformats/cid"
import { create } from "multiformats/hashes/digest"
export const storage = "http://storage-provider-envoy.storage-provider-ns.svc.cluster.local:8080"
export const index = "http://index-envoy.index-ns.svc.cluster.local:8080"
export const oci = "https://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8443"
export async function keyFromFile(name: string) {
  const jwk = await Bun.file(`${process.env.E2E_DPOP_KEY_DIR ?? "/etc/dpop-keys"}/${name}.json`).json()
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  return { privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]), publicKey: await crypto.subtle.importKey("jwk", pub, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]) }
}
export async function principal(key: CryptoKeyPair) {
  const j = await crypto.subtle.exportKey("jwk", key.publicKey)
  const bytes = createHash("sha256").update(JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y })).digest()
  return CID.create(1, 0xeb51, create(0x12, bytes)).toString()
}
export function authenticated(key: CryptoKeyPair) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString()
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set("authorization", `Bearer ${await generateProof(key, url, init?.method ?? (input instanceof Request ? input.method : "GET"))}`)
    return fetch(input, { ...init, headers })
  }
}
export async function fund(key: CryptoKeyPair, origin: string, amount = "1000000000000") {
  const res = await authenticated(key)(origin + "/account.v1.AccountService/CreditBalance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount }) })
  if (!res.ok) throw new Error(`fund ${origin}: ${res.status} ${await res.text()}`)
}
export async function signAdvertisement(key: CryptoKeyPair, advertisement: any) {
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey)
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", jwk })).toString("base64url")
  const payload = Buffer.from(toJsonString(SignedAdvertisementSchema, fromJson(SignedAdvertisementSchema, { v: "paid.index.advertisement.v1", functionality: advertisement.functionality, providers: advertisement.providers }))).toString("base64url")
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${header}.${payload}`))
  return { ...advertisement, signature: `${header}.${payload}.${Buffer.from(signature).toString("base64url")}` }
}

export function advertise(key: CryptoKeyPair, advertisement: any) {
  return createIndexClient(index, authenticated(key)).advertise({ advertisement: fromJson(ProviderAdvertisementSchema, advertisement) })
}
export async function search(key: CryptoKeyPair, request: any) {
  const response = await createIndexClient(index, authenticated(key)).searchProvider(fromJson(SearchProviderRequestSchema, request))
  return toJson(SearchProviderResponseSchema, response, { alwaysEmitImplicit: true })
}
