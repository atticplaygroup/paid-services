// Operator CronJob: refreshes the welcome blob; cashier funds lazily.
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
const provider = process.env.PROVIDER_ORIGIN!
const headers = { "content-type": "application/json", "x-request-id": crypto.randomUUID() }
const htu = `${provider}/kvstore.v1.MeteredStorageService/CreateCASValue`
const bytes = await Bun.file("/fixtures/welcome.txt").bytes()
const key = CID.createV1(0x55, await sha256.digest(bytes)).toString()
const ca = await Bun.file("/tls/ca.crt").text()
const response = await fetch(htu, {
  method: "POST", headers,
  body: JSON.stringify({ key, value: Buffer.from(bytes).toString("base64"), codec: "CODEC_RAW", storageBackend: "STORAGE_BACKEND_BLOB_STORAGE", ttl: `${process.env.TTL_SECONDS}s` }),
  proxy: process.env.PROXY_ORIGIN,
  tls: { ca },
})
if (!response.ok) throw new Error(`Upload: ${response.status} ${await response.text()}`)
const created = await response.json() as { name?: string }
if (created.name?.split("/").at(-1) !== key) throw new Error(`Unexpected upload response: ${JSON.stringify(created)}`)
for (const origin of [provider, provider.replace(/^http:/, "https:").replace(/:8080$/, ":8443")]) {
  const download = await fetch(`${origin}/kvstore.v1.MeteredStorageService/GetCASValue`, { method: "POST", headers: { ...headers, "x-request-id": crypto.randomUUID() }, body: JSON.stringify({ key }), proxy: process.env.PROXY_ORIGIN, tls: { ca } })
  if (!download.ok) throw new Error(`Download: ${download.status} ${await download.text()}`)
  const result = await download.json() as { value: string }
  if (!Buffer.from(result.value, "base64").equals(Buffer.from(bytes))) throw new Error(`Incorrect bytes at ${origin}`)
  console.log(`Verified ${origin}: ${new TextDecoder().decode(bytes).trimEnd()}`)
}
console.log(`Verified CID: ${key}`)
