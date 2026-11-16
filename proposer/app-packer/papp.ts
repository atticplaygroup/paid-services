import { publishRaw } from "../../applications/ipfs/src/pack.ts"
import { pappId, verifyManifest, type PappManifest } from "../../applications/papp-sdk/src/lib.ts"
import { signReleaseVariant, variantKey } from "../../applications/papp-sdk/src/variant.ts"
export async function signManifest(key: CryptoKeyPair, value: Omit<PappManifest, "signature">): Promise<PappManifest> {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", jwk: await crypto.subtle.exportKey("jwk", key.publicKey) })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url")
  const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${header}.${payload}`))).toString("base64url")
  return { ...value, signature: `${header}.${payload}.${signature}` }
}
export async function publishManifest(manifest: PappManifest, storage: string, paid: typeof fetch, key: CryptoKeyPair) {
  const id = await pappId(manifest.name, manifest.proposer)
  await verifyManifest(manifest, id)
  if (manifest.functionality.variant?.name !== id || manifest.functionality.variant?.maintainer !== manifest.proposer) throw new Error("manifest functionality must identify its pApp and proposer")
  variantKey(manifest.functionality)
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  const cid = await publishRaw(bytes, storage, paid)
  const anchor = await signReleaseVariant(key, manifest.functionality, cid)
  const response = await paid(storage + "/kvstore.v1.MeteredStorageService/CreateProtectedValueAnchor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor }) })
  if (!response.ok) throw new Error(`publish pApp variant: ${response.status} ${await response.text()}`)
  return { cid, functionality: manifest.functionality }
}

export { packFiles, carBytes, publishBlocks } from "../../applications/ipfs/src/pack.ts"
