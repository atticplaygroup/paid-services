import { expect, test } from "bun:test"
import { proposerPrincipal, verifyProposer } from "./lib.ts"
import { fromJson, ProviderAdvertisementSchema } from "../../router/src/lib.ts"

const encode = (value: Uint8Array) => btoa(Array.from(value, b => String.fromCharCode(b)).join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)))

test("proposer admission verifies signer, signed content and provider membership", async () => {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey)
  const principal = await proposerPrincipal(jwk)
  const functionality = { behavior: { name: "mutation", maintainer: "test", tag: "v1" }, variant: { name: "app", maintainer: "test", tag: "v1" } }
  const provider = { origin: "https://proposer", principal, expireTime: new Date(Date.now() + 60000).toISOString() }
  const header = json({ alg: "ES256", jwk })
  const payload = json({ v: "paid.index.advertisement.v1", functionality, providers: [provider] })
  const signature = encode(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${header}.${payload}`))))
  const ad = fromJson(ProviderAdvertisementSchema, { functionality, providers: [provider], signature: `${header}.${payload}.${signature}` })
  expect(await verifyProposer(ad.providers[0], ad, principal)).toBe(true)
  expect(await verifyProposer(ad.providers[0], ad, "other-proposer")).toBe(false)
  expect(await verifyProposer({ ...ad.providers[0], origin: "https://impostor" }, ad, principal)).toBe(false)
  ad.providers[0].origin = "https://impostor"
  expect(await verifyProposer(ad.providers[0], ad, principal)).toBe(false)
})
