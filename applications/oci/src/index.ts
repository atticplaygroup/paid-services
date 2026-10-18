import { createOciApp } from "./server.js"
import { KvstoreClient } from "./storage/kvstore.js"
import { MeterClient } from "./meter.js"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { p256 } from "@noble/curves/nist.js"

const port = Number(process.env.PORT ?? 3000)
const kvstoreAddress = process.env.KVSTORE_ADDRESS ?? "http://localhost:8080"
const deductionAddress = process.env.DEDUCTION_ADDRESS ?? "http://localhost:9192"
const deductionAmount = Number(process.env.DEDUCTION_AMOUNT ?? 1)
const disableMetering = (process.env.DISABLE_METERING ?? "false") === "true"
const readOnly = (process.env.READ_ONLY_MODE ?? "false") === "true"
const dpopPrivateKeyJson = process.env.DPOP_PRIVATE_KEY
const dpopMasterSecret = process.env.DPOP_MASTER_SECRET
const outproxyAddress = process.env.OUTPROXY_ADDRESS

function sha256(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const input of inputs) hash.update(input)
  return new Uint8Array(hash.digest())
}

function base64Url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

async function importP256Seed(seed: Uint8Array): Promise<CryptoKeyPair> {
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

async function loadDpopKeypair(): Promise<CryptoKeyPair | undefined> {
  if (dpopPrivateKeyJson && dpopMasterSecret) throw new Error("DPOP_PRIVATE_KEY and DPOP_MASTER_SECRET are mutually exclusive")
  if (dpopMasterSecret) {
    if (!validateMnemonic(dpopMasterSecret.normalize("NFKD"), wordlist)) throw new Error("DPOP_MASTER_SECRET must be a BIP-39 mnemonic")
    const seed = sha256(new TextEncoder().encode("direct"), new TextEncoder().encode(dpopMasterSecret.normalize("NFKD")))
    return importP256Seed(seed)
  }
  if (!dpopPrivateKeyJson) return undefined
  const { importDpopPrivateKeyJson } = await import("./auth/dpop-import.js")
  return importDpopPrivateKeyJson(dpopPrivateKeyJson)
}

const dpopKeypair = await loadDpopKeypair()
const kvstore = new KvstoreClient(kvstoreAddress, dpopKeypair, outproxyAddress)
const meter = new MeterClient({
  deductionAddress,
  defaultAmount: deductionAmount,
  disabled: disableMetering,
})

const app = createOciApp({ kvstore, meter, readOnly })

console.log(`oci registry listening on :${port} (disableMetering=${disableMetering}, dpop=${!!dpopKeypair}, readOnly=${readOnly})`)

export default {
  port,
  fetch: app.fetch,
}
