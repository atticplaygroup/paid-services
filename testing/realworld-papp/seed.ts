import { keyFromFile, principal, storage, index, fund, signAdvertisement, advertise } from '../routing/helpers.ts';
import { KvstoreClient, publishFiles, downloadFiles } from '../../proposer/app-packer/index.ts';
import { createAuthenticatedFetch } from '../../applications/client-auth/src/lib.ts';
import type { Config } from './config.ts';

const proposer = await keyFromFile('pusher'), variantKey = await keyFromFile('oci-provider'), replica = await keyFromFile('puller');
const owner = await principal(proposer), maintainer = await principal(variantKey);
await fund(proposer, storage, '1000000000000000');
for (const [key, origins] of [
  [proposer, [index]], [variantKey, [storage, index]],
  [replica, [storage, 'http://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080']],
] as const) for (const origin of origins) await fund(key, origin, '100000000000000');
const behaviorClient = new KvstoreClient(storage, proposer, createAuthenticatedFetch(proposer));
const variantClient = new KvstoreClient(storage, variantKey, createAuthenticatedFetch(variantKey));
const config: Config = {
  indices: [index], providerScorings: [await Bun.file('testing/routing/scoring.json').json()],
  proposerPrincipal: owner, issuer: 'http://localhost:4000',
  sql: {
    behavior: { maintainer: owner, name: 'realworld-papp-sql-behavior', tag: 'v1' },
    variant: { maintainer, name: 'realworld-papp-sql-variant', tag: 'v1' },
  },
};
await publishFiles(behaviorClient, config.sql.behavior, {
  'behavior.md': new Uint8Array(await Bun.file('examples/realworld-papp/frontend/behavior.md').arrayBuffer()),
  'schema.sql': new Uint8Array(await Bun.file('examples/realworld-papp/baseapp/public-schema.sql').arrayBuffer()),
  'schema.graphql': new Uint8Array(await Bun.file('examples/realworld-papp/frontend/generated/schema.graphql').arrayBuffer()),
});
await publishFiles(variantClient, config.sql.variant, {
  'behavior.json': new TextEncoder().encode(JSON.stringify({ behavior: config.sql.behavior })),
  'variant.md': new TextEncoder().encode('POST /sql executes parameterized read-only SQL against realworld.blog_* public tables. Responses are {columns,rows}; non-null values are strings.'),
});
await downloadFiles(behaviorClient, config.sql.behavior);
await downloadFiles(variantClient, config.sql.variant);
await advertise(variantKey, await signAdvertisement(variantKey, {
  functionality: config.sql,
  providers: [{ origin: 'http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080', principal: await principal(replica), coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 86400000).toISOString() }],
}));
console.log('REALWORLD_FIXTURE=' + Buffer.from(JSON.stringify(config)).toString('base64'));
