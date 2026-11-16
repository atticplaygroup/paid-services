import { keyFromFile, principal, advertise, signAdvertisement, index, storage, fund } from "../routing/helpers.ts"
import type { Config } from "../../examples/realworld/client.ts"
// Renew fixture advertisements for repeat runs after the seed's leases expire.
export async function refreshRealworldAdvertisements(config: Config) {
  const owner = await keyFromFile("pusher"), variant = await keyFromFile("oci-provider"), replica = await keyFromFile("puller")
  for (const key of [owner, variant]) await fund(key, index)
  for (const [functionality, origin, signer, providerPrincipal] of [
    [config.mutation, "http://realworld-proposer.pusher-ns.svc.cluster.local:3000", owner, await principal(owner)],
    [config.sql, "http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080", variant, await principal(replica)],
    [config.objects, storage, variant, await principal(variant)],
  ] as const) await advertise(signer, await signAdvertisement(signer, { functionality, providers: [{ origin, principal: providerPrincipal, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 86400000).toISOString() }] }))
}
