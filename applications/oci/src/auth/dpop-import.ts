/**
 * Import an ES256 (P-256) DPoP private key from a JSON JWK string.
 * Shared between accountant and OCI for outgoing DPoP auth.
 */
export async function importDpopPrivateKeyJson(raw: string): Promise<CryptoKeyPair> {
  const privateJwk = JSON.parse(raw) as JsonWebKey
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.d) {
    throw new Error("dpop_private_key must be an ES256 (P-256) private JWK")
  }
  if (!privateJwk.x || !privateJwk.y) {
    throw new Error("dpop_private_key JWK must include public x/y coordinates")
  }
  const publicJwk: JsonWebKey = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    ),
    crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    ),
  ])
  return { privateKey, publicKey }
}
