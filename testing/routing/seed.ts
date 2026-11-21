import { generateKeyPair } from "dpop"
import { KvstoreClient, publish, definitionStorage } from "./functionalities/oci/ts/index.ts"
import { storage, index, oci, keyFromFile, principal, authenticated, fund, signAdvertisement, advertise } from "./helpers.ts"

const behaviorKey = await keyFromFile("pusher")
const variantKey = await keyFromFile("oci-provider")
const behaviorOwner = await principal(behaviorKey)
const owner = await principal(variantKey)
if (behaviorOwner === owner) throw new Error("maintainers must differ")
await fund(behaviorKey, storage)
await fund(variantKey, storage)
const behaviorClient = new KvstoreClient(storage, behaviorKey, authenticated(behaviorKey))
const variantClient = new KvstoreClient(storage, variantKey, authenticated(variantKey))
const functionality = { behavior: { name: "routing-behavior", maintainer: behaviorOwner, tag: "v1" }, variant: { name: "routing-variant", maintainer: owner, tag: "v1" } }
const scoring = await Bun.file("routing/scoring.json").json()
if (scoring.behavior.maintainer !== behaviorOwner || scoring.variant.maintainer !== owner) throw new Error("scoring fixture maintainer mismatch")
const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x))
await publish(behaviorClient, behaviorOwner, functionality.behavior.name, "v1", { "behavior.md": new Uint8Array(await Bun.file("routing/functionalities/oci/behavior/behavior.md").arrayBuffer()) })
await publish(behaviorClient, behaviorOwner, scoring.behavior.name, "v1", {
  "behavior.md": new TextEncoder().encode("Score each provider in an advertisement. Return one numeric score per provider; higher ranks first. The scoring functionality identifies the shared units and ordering."),
})
await publish(variantClient, owner, scoring.variant.name, "v1", {
  "behavior.json": encode({ behavior: scoring.behavior }),
  "variant.md": new TextEncoder().encode("Score is the index's acceptance timestamp in Unix milliseconds, encoded as a double. Every provider in the same advertisement receives this score. Ties use provider origin order."),
})
const files = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`file-${i}.txt`, new TextEncoder().encode(Buffer.from(crypto.getRandomValues(new Uint8Array(128))).toString("hex"))]))
const layers = await publish(variantClient, owner, "routing-files", "v1", files)
const collection = { owner, name: "routing-files", tag: "v1" }
await publish(variantClient, owner, functionality.variant.name, "v1", { "behavior.json": encode({ behavior: functionality.behavior }), "variant.json": encode(collection), "variant.md": new Uint8Array(await Bun.file("routing/functionalities/oci/variant/variant.md").arrayBuffer()) })
const deadLow = "http://dead-low-envoy.dead-low-ns.svc.cluster.local:8080"
const deadHigh = "http://dead-high-envoy.dead-high-ns.svc.cluster.local:8080"
const provider = (origin: string, principal: string) => ({ origin, principal, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() })
for (const [key, origin] of [[await generateKeyPair("ES256"), deadLow], [variantKey, oci], [await generateKeyPair("ES256"), deadHigh]] as const) {
  await fund(key, index)
  const ad = await signAdvertisement(key, { functionality, providers: [provider(origin, await principal(key))] })
  await advertise(key, ad)
  await Bun.sleep(20)
}
// Advertise storage of the definitions themselves as functionalities. A caller
// can discover their OCI provider before loading or interpreting the documents.
for (const [definition, client, signingKey] of [[functionality.behavior, behaviorClient, behaviorKey], [functionality.variant, variantClient, variantKey], [scoring.behavior, behaviorClient, behaviorKey], [scoring.variant, variantClient, variantKey]] as const) {
  const stored = definitionStorage(definition, functionality.behavior)
  await publish(client, definition.maintainer, stored.variant.name, stored.variant.tag, {
    "behavior.json": encode({ behavior: functionality.behavior }),
    "variant.json": encode({ owner: definition.maintainer, name: definition.name, tag: definition.tag }),
    "variant.md": new TextEncoder().encode("Serve the signed definition repository identified by variant.json."),
  })
  await fund(signingKey, index)
  const ad = await signAdvertisement(signingKey, { functionality: stored, providers: [provider(oci, owner)] })
  await advertise(signingKey, ad)
}
console.log("ROUTING_FIXTURE=" + Buffer.from(JSON.stringify({ functionality, scoring, collection, layers, contents: Object.values(files).map(f => Buffer.from(f).toString("base64")), deadLow, deadHigh })).toString("base64"))
