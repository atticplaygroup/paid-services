import { generateKeyPair } from "dpop"
import { fund, index, storage } from "../routing/helpers.ts"
import { refreshRealworldAdvertisements } from "./refresh.ts"
import { setupPapp } from "./papp-fixture.ts"

// Keep the E2E's fixture-funded services available for manual browser use.
const config = await Bun.file("/etc/realworld-papp/fixture.json").json()
await refreshRealworldAdvertisements(config)
const customer = await generateKeyPair("ES256", { extractable: true })
for (const origin of [index, storage, "http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080"]) {
  await fund(customer, origin, "100000000000000")
}
const tls = process.env.PAPP_DEMO_TLS_DIR ? { cert: process.env.PAPP_DEMO_TLS_DIR + "/cert.pem", key: process.env.PAPP_DEMO_TLS_DIR + "/key.pem" } : undefined
const papp = await setupPapp(config, customer, "http://realworld-baseapp.pusher-ns.svc.cluster.local:3000", { tls })
const caPath = process.env.PAPP_DEMO_TLS_DIR ? process.env.PAPP_DEMO_TLS_DIR + "/ca.pem" : papp.ca
await Bun.write("/tmp/papp-demo.json", JSON.stringify({ url: papp.base, spki: papp.spki, ...(await Bun.file(caPath).exists() ? { ca: caPath } : {}) }))
console.log(`RealWorld pApp ready: ${papp.base}`)
// Release providers expire after one hour; manual demos can run much longer.
// Renew the same signed releases rather than creating new versions.
let refreshing = false
const renewal = setInterval(async () => {
  if (refreshing) return
  refreshing = true
  try {
    await papp.refreshAdvertisements()
    await refreshRealworldAdvertisements(config)
  } catch (error) {
    console.error("Demo advertisement renewal failed; retrying next minute", error)
  } finally { refreshing = false }
}, 60000)
await new Promise<void>(resolve => {
  process.once("SIGINT", resolve)
  process.once("SIGTERM", resolve)
})
clearInterval(renewal)
await papp.close()
