import { keyFromFile, principal, signAdvertisement } from "../routing/helpers.ts"
import { createIndexClient, fromJson, ProviderAdvertisementSchema } from "../../applications/router/src/lib.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { generateKeyPair } from "dpop"
const config = await Bun.file(process.env.REALWORLD_CONFIG_FILE!).json()
const owner = await keyFromFile("pusher"), variant = await keyFromFile("oci-provider")
const replicaPrincipal = await principal(await keyFromFile("puller"))
const index = "http://localhost:28080", storage = "http://localhost:28081", sql = "http://localhost:28082", proposer = "http://localhost:28083"
for (const [name, origin, signer] of [["mutation", proposer, owner], ["sql", sql, variant], ["objects", storage, variant]] as const) {
  const ad = await signAdvertisement(signer, { functionality: config[name], providers: [{ origin, principal: name === "sql" ? replicaPrincipal : await principal(signer), coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 86400000).toISOString() }] })
  await createIndexClient(index, createAuthenticatedFetch(signer)).advertise({ advertisement: fromJson(ProviderAdvertisementSchema, ad) })
}
const key = await generateKeyPair("ES256", { extractable: true })
for (const origin of [index, storage, sql]) {
  const response = await createAuthenticatedFetch(key)(origin + "/account.v1.AccountService/CreditBalance", { method: "POST", headers: { "content-type": "application/json" }, body: '{"amount":"100000000000000"}' })
  if (!response.ok) throw new Error(`funding ${origin}: ${response.status}`)
}
config.indices = [index]
await Bun.write(process.env.REALWORLD_CONFIG_FILE!, JSON.stringify(config))
const keyFile = process.env.REALWORLD_CONFIG_FILE! + ".client-key.json"
await Bun.write(keyFile, JSON.stringify(await crypto.subtle.exportKey("jwk", key.privateKey)))
const frontend = Bun.spawn([process.execPath, "examples/realworld/frontend-server.ts"], { env: { ...process.env, REALWORLD_CLIENT_KEY_FILE: keyFile }, stdout: "inherit", stderr: "inherit" })
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => frontend.kill())
console.log("Open http://localhost:3001 — fixture credit is enabled; log in or register with the fixture IdP.")
process.exit(await frontend.exited)
