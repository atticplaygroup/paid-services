import { generateKeyPair } from 'dpop';
import { createAuthenticatedFetch } from '../../applications/client-auth/src/lib.ts';
import { keyFromFile, principal, fund, index, storage, advertise, signAdvertisement } from '../routing/helpers.ts';
import { setupGateway } from './gateway-fixture.ts';

// This fixture requires only the routing/storage deployment. No application
// database, mutation server, identity provider or application build is involved.
export async function frameworkFixture() {
  const routing = await Bun.file('/etc/routing/fixture.json').json();
  const owner = await keyFromFile('pusher'), publisher = await principal(owner);
  const customer = await generateKeyPair('ES256', { extractable: true });
  for (const origin of [index, storage]) {
    await fund(customer, origin, '100000000000000');
    await fund(owner, origin, '1000000000000000');
  }
  const objects = { behavior: { name: 'framework-objects', maintainer: publisher, tag: 'v1' }, variant: { name: 'framework-objects', maintainer: publisher, tag: 'v1' } };
  await advertise(owner, await signAdvertisement(owner, { functionality: objects, providers: [{ origin: storage, principal: publisher, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() }] }));
  const config = { indices: [index], providerScorings: [routing.scoring] };
  const gateway = await setupGateway(config, customer, {
    name: 'framework-probe',
    async files() {
      const build = await Bun.build({ entrypoints: ['testing/papp/probe.ts'], target: 'browser', minify: true });
      if (!build.success) throw new AggregateError(build.logs);
      const encode = (s: string) => new TextEncoder().encode(s);
      return {
        'index.html': encode('<!doctype html><meta charset="utf-8"><title>Framework probe</title><h1>Framework probe</h1><span id="daily-budget"></span><p id="probe-ready"></p><script src="/config.js"></script><script type="module" src="/app.js"></script>'),
        'config.js': encode('globalThis.FRAMEWORK_PROBE={};'),
        'app.js': new Uint8Array(await build.outputs[0].arrayBuffer()),
      };
    },
  });
  const paid = createAuthenticatedFetch(customer);
  async function balance(origin: string) {
    const r = await paid(origin + '/account.v1.AccountService/GetBalance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error(`balance ${origin}: ${r.status}`);
    return BigInt((await r.json()).balance);
  }
  return { gateway, objects, balance };
}
