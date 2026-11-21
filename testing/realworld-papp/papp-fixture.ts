import { expect as browserExpect } from 'playwright/test';
import { setupGateway } from '../papp/gateway-fixture.ts';
import type { Config } from './config.ts';
import type { Page } from 'playwright';

// Application-only setup: built frontend assets, OIDC and the pinned mutation API.
// Gateway publication, TLS and user-server transport are shared infrastructure.
export async function setupPapp(config: Config, customer: CryptoKeyPair, proposerOrigin: string, options: { tls?: { cert: string; key: string } } = {}) {
  if (!config.sql) throw new Error('Seed the migrated pApp SQL publication before setup');
  const gateway = await setupGateway(config, customer, {
    name: 'realworld', tls: options.tls,
    async files(base) {
      const files: Record<string, Uint8Array> = {};
      const root = 'examples/realworld-papp/frontend/dist';
      for await (const name of new Bun.Glob('**/*').scan({ cwd: root, onlyFiles: true })) {
        files[name] = new Uint8Array(await Bun.file(root + '/' + name).arrayBuffer());
      }
      if (!files['index.html']) throw new Error('Build examples/realworld-papp/frontend before publishing');
      const { indices: _indices, providerScorings: _scorings, ...appConfig } = config;
      const frontendConfig = { ...appConfig, sql: config.sql, callback: base + '/callback', oidcOrigin: 'https://localhost:4000', mutationOrigin: 'https://localhost:3004' };
      files['config.js'] = new TextEncoder().encode(`globalThis.PAID_CONFIG=${JSON.stringify(frontendConfig).replace(/</g, '\\u003c')}`);
      return files;
    },
  });
  const idpOrigin = 'http://localhost:4005';
  const idp = Bun.spawn([process.execPath, 'testing/shared/oidc-idp.ts'], { env: { ...process.env, PORT: '4005', OIDC_CALLBACKS: JSON.stringify([gateway.base + '/callback', 'https://localhost:3004/callback']), OIDC_ISSUER: config.issuer }, stdout: 'inherit', stderr: 'inherit' });
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (await fetch(idpOrigin + '/healthz').then(r => r.ok).catch(() => false)) { ready = true; break }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error('pApp fixture IdP did not start');
    for (const [port, origin] of [[4000, idpOrigin], [3004, process.env.PAPP_MUTATION_ORIGIN ?? proposerOrigin]] as const) {
      servers.push(Bun.serve({ hostname: '0.0.0.0', port, tls: gateway.tls, fetch(request) {
        const url = new URL(request.url);
        const target = origin + url.pathname + url.search;
        if (port === 3004) gateway.calls.push({ url: target, method: request.method, authorization: request.headers.get('authorization') ?? undefined });
        // Next serves compressed pages/assets. Preserve wire bytes alongside their
        // Content-Encoding header when forwarding through the fixture TLS proxy.
        return fetch(target, { method: request.method, headers: request.headers, body: request.body, redirect: 'manual', decompress: false });
      } }));
    }
  } catch (error) {
    for (const server of servers) server.stop(true);
    idp.kill(); await idp.exited; await gateway.close(); throw error;
  }
  return {
    base: gateway.base, ca: gateway.ca, spki: gateway.spki, idpOrigin, calls: gateway.calls, setMode: gateway.setMode,
    refreshAdvertisements: gateway.refreshAdvertisements,
    async bootstrap(page: Page) {
      await gateway.configure(page);
      await browserExpect(page.getByRole('link', { name: 'Global Feed', exact: true })).toBeVisible({ timeout: 60000 });
    },
    async close() { for (const server of servers) server.stop(true); idp.kill(); await idp.exited; await gateway.close() },
  };
}
