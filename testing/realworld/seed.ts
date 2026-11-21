import { keyFromFile, principal, storage, index, fund, signAdvertisement, advertise } from "../routing/helpers.ts"
import { KvstoreClient, publishFiles, downloadFiles } from "../../proposer/app-packer/index.ts"
import { createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
const proposer = await keyFromFile("pusher"), variantKey = await keyFromFile("oci-provider"), replica = await keyFromFile("puller")
const owner = await principal(proposer), maintainer = await principal(variantKey)
// Scheduled publication pays retention costs for every content-addressed
// manifest and tag anchor, so it needs more fixture credit than a reader.
await fund(proposer, storage, "1000000000000000")
// Conversion reads are billed to the OCI provider's own downstream identity.
await fund(variantKey, storage, "100000000000000")
for (const [key, origins] of [[proposer, [storage, index]], [variantKey, [storage, index]], [replica, [storage, "http://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080"]]] as const) for (const origin of origins) await fund(key, origin)
const behaviorClient = new KvstoreClient(storage, proposer, createAuthenticatedFetch(proposer))
const variantClient = new KvstoreClient(storage, variantKey, createAuthenticatedFetch(variantKey))
const config: any = { indices: [index], providerScorings: [await Bun.file("testing/routing/scoring.json").json()], proposerPrincipal: owner, issuer: "http://localhost:4000", callback: "http://localhost:3001/callback" }
for (const [name, file, origin, providerPrincipal] of [
  ["mutation", "mutation.md", "http://realworld-proposer.pusher-ns.svc.cluster.local:3000", owner],
  ["sql", "read.md", "http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080", await principal(replica)],
  ["objects", "objects.md", storage, maintainer],
]) {
  const functionality = { behavior: { maintainer: owner, name: `realworld-${name}-behavior`, tag: "v1" }, variant: { maintainer, name: `realworld-${name}-variant`, tag: "v1" } }
  await publishFiles(behaviorClient, functionality.behavior, {
    "behavior.md": new Uint8Array(await Bun.file(`examples/realworld/behavior/${file}`).arrayBuffer()),
    ...(name === "sql" ? { "schema.sql": new Uint8Array(await Bun.file("examples/realworld/schema.sql").arrayBuffer()) } : {}),
  })
  await publishFiles(variantClient, functionality.variant, {
    "behavior.json": new TextEncoder().encode(JSON.stringify({ behavior: functionality.behavior })),
    "variant.md": new Uint8Array(await Bun.file("examples/realworld/variant/variant.md").arrayBuffer()),
    "variant.json": new TextEncoder().encode(JSON.stringify({ proposerPrincipal: owner, schemaVersion: "v1", application: "realworld" })),
  })
  // Verify publications against independently configured maintainers.
  await downloadFiles(behaviorClient, functionality.behavior)
  await downloadFiles(variantClient, functionality.variant)
  const key = name === "mutation" ? proposer : variantKey
  await advertise(key, await signAdvertisement(key, { functionality, providers: [{ origin, principal: providerPrincipal, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 86400000).toISOString() }] }))
  config[name] = functionality
}
console.log("REALWORLD_FIXTURE=" + Buffer.from(JSON.stringify(config)).toString("base64"))
