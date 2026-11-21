import { describe, expect, it } from "bun:test"
import * as dpop from "dpop"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, base64UrlDecode, dpopSeed, importDpopSeed, normalizeHtu, providerId, sha256, thumbprintFromJwk } from "./identity.js"

function b64url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

describe("identity", () => {
  it("preserves SHA-256 identity derivation across browser and server runtimes", () => {
    const encode = (value: string) => new TextEncoder().encode(value)
    expect(bytesToHex(sha256(encode("a"), encode("bc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(bytesToHex(sha256())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  it("derives valid P-256 keys and signs DPoP proofs", async () => {
    const seed = sha256(new TextEncoder().encode("salt"), new TextEncoder().encode("secret"), new TextEncoder().encode("provider.example"))
    const keypair = await importDpopSeed(seed)
    const expectedPublic = p256.getPublicKey(seed, false)
    const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
    expect(new Uint8Array(base64UrlDecode(jwk.x as string))).toEqual(new Uint8Array(expectedPublic.slice(1, 33)))
    expect(new Uint8Array(base64UrlDecode(jwk.y as string))).toEqual(new Uint8Array(expectedPublic.slice(33)))
    const proof = await dpop.generateProof(keypair, normalizeHtu("https://provider.example/path?query=ignored"), "GET")
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(proof.split(".")[1])))
    expect(proof.split(".")).toHaveLength(3)
    expect(decoded.htm).toBe("GET")
    expect(decoded.htu).toBe("https://provider.example/path")
  })

  it("derives distinct and deterministic per-host identities", async () => {
    const firstSeed = dpopSeed(new TextEncoder().encode("salt"), new TextEncoder().encode("secret"), "provider.example")
    const secondSeed = dpopSeed(new TextEncoder().encode("salt"), new TextEncoder().encode("secret"), "exchange.example")
    expect(firstSeed).not.toEqual(secondSeed)
    const first = await importDpopSeed(firstSeed)
    const second = await importDpopSeed(secondSeed)
    const firstId = providerId(thumbprintFromJwk(await crypto.subtle.exportKey("jwk", first.publicKey)))
    const secondId = providerId(thumbprintFromJwk(await crypto.subtle.exportKey("jwk", second.publicKey)))
    expect(firstId).toMatch(/^[a-z2-7]{62}$/)
    expect(firstId).not.toBe(secondId)
  })
})
