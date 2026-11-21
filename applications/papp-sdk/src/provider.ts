import { type Provider, type ProviderAdvertisement, toJson, toJsonString, fromJson, ProviderAdvertisementSchema, SignedAdvertisementSchema } from "../../router/src/lib.ts"
import { proposerPrincipal } from "./manifest.ts"
const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))

/** Require a provider advertisement signed by the intended proposer. */
export async function verifyProposer(provider: Provider, advertisement: ProviderAdvertisement, intended: string) {
  try {
    const [header, payload, signature, extra] = advertisement.signature.split(".")
    if (extra || !signature) return false
    const h = JSON.parse(new TextDecoder().decode(bytes(header)))
    if (h.alg !== "ES256" || h.jwk?.d || h.jwk?.kty !== "EC" || h.jwk?.crv !== "P-256" || await proposerPrincipal(h.jwk) !== intended) return false
    const key = await crypto.subtle.importKey("jwk", h.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signature), new TextEncoder().encode(`${header}.${payload}`))) return false
    const signed = fromJson(SignedAdvertisementSchema, JSON.parse(new TextDecoder().decode(bytes(payload))))
    const json: any = toJson(ProviderAdvertisementSchema, advertisement)
    const clear = (p: any) => { delete p.scores; p.exchanges?.forEach(clear) }
    json.providers.forEach(clear)
    const expected = fromJson(SignedAdvertisementSchema, { v: "paid.index.advertisement.v1", functionality: json.functionality, providers: json.providers })
    return toJsonString(SignedAdvertisementSchema, signed) === toJsonString(SignedAdvertisementSchema, expected) && advertisement.providers.some(p => p.origin === provider.origin && p.principal === provider.principal)
  } catch { return false }
}
