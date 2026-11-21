import { keyFromFile, principal, advertise, signAdvertisement, index, fund } from '../routing/helpers.ts';
import type { Config } from './config.ts';
export async function refreshRealworldAdvertisements(config: Config) {
  const signer = await keyFromFile('oci-provider'), replica = await keyFromFile('puller');
  await fund(signer, index);
  await advertise(signer, await signAdvertisement(signer, {
    functionality: config.sql,
    providers: [{ origin: 'http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080', principal: await principal(replica), coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 86400000).toISOString() }],
  }));
}
