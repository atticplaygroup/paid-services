import { createOciApp } from "./server.js"
import { KvstoreClient } from "./storage/kvstore.js"
import { MeterClient } from "./meter.js"

const port = Number(process.env.PORT ?? 3000)
const kvstoreAddress = process.env.KVSTORE_ADDRESS ?? "http://localhost:8080"
const alsAddress = process.env.ALS_ADDRESS ?? "http://localhost:9192"
const deductionAmount = Number(process.env.DEDUCTION_AMOUNT ?? 1)
const disableMetering = (process.env.DISABLE_METERING ?? "false") === "true"
const readOnly = (process.env.READ_ONLY_MODE ?? "false") === "true"
const dpopPrivateKeyJson = process.env.DPOP_PRIVATE_KEY
const outproxyAddress = process.env.OUTPROXY_ADDRESS

async function loadDpopKeypair(): Promise<CryptoKeyPair | undefined> {
  if (!dpopPrivateKeyJson) return undefined
  const { importDpopPrivateKeyJson } = await import("./auth/dpop-import.js")
  return importDpopPrivateKeyJson(dpopPrivateKeyJson)
}

const dpopKeypair = await loadDpopKeypair()
const kvstore = new KvstoreClient(kvstoreAddress, dpopKeypair, outproxyAddress)
const meter = new MeterClient({
  alsAddress,
  defaultAmount: deductionAmount,
  disabled: disableMetering,
})

const app = createOciApp({ kvstore, meter, readOnly })

console.log(`oci registry listening on :${port} (disableMetering=${disableMetering}, dpop=${!!dpopKeypair}, readOnly=${readOnly})`)

export default {
  port,
  fetch: app.fetch,
}
