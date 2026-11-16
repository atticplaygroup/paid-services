import { expect } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Page, BrowserContext } from 'playwright';
import { pappId, rendering, type PappManifest } from '../../applications/papp-sdk/src/lib.ts';
import { workerConfig } from '../../applications/papp-gateway/src/config-store.ts';
import { index, storage } from '../routing/helpers.ts';
import type { GatewayFixture } from './gateway-fixture.ts';

export async function bootstrap(gateway: GatewayFixture, page: Page, mode: string, balance: (origin: string) => Promise<bigint>) {
  const origins = mode === 'paid' ? [index, storage] : [index];
  const before = await Promise.all(origins.map(balance));
  await gateway.configure(page);
  await browserExpect(page.locator('#probe-ready')).toHaveText('ready', { timeout: 60000 });
  await browserExpect(page.locator('#daily-budget')).toHaveText('500000');
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  expect(await page.evaluate(() => 'PAID_CLIENT_KEY' in globalThis)).toBe(false);
  const count = gateway.configurationBounces;
  await page.reload();
  await browserExpect(page.locator('#probe-ready')).toHaveText('ready', { timeout: 60000 });
  expect(gateway.configurationBounces).toBe(count);
  for (let attempt = 0; attempt < 100; attempt++) {
  const after = await Promise.all(origins.map(balance));
  if (after.every((value, i) => value < before[i])) return;
  await Bun.sleep(100);
  }
  throw new Error('Expected gateway metering deductions');
}

export async function lifecycle(gateway: GatewayFixture, page: Page, context: BrowserContext, objects: any) {
  const { base, id, proposer } = gateway;
  const savedProfile = (await page.evaluate(workerConfig)).profile;
  // A previously configured browser can retain an expired Kubo address or an
  // old object functionality. The current gateway must override both on reload.
  await page.evaluate(async () => {
    const response = await fetch('/__papp/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server: 'https://localhost:3002', blockGateway: 'http://127.0.0.1:1', objects: { variant: { name: 'removed-release' } }, delegatedRoutingUrl: 'http://127.0.0.1:1' }) });
    if (!response.ok) throw new Error(await response.text());
  });
  await page.reload();
  await browserExpect(page.locator('#probe-ready')).toHaveText('ready', { timeout: 60000 });
  expect((await page.evaluate(workerConfig)).profile).toBe(savedProfile);
  const secondManifest = await gateway.publishApp("framework-probe-second", 1);
  const second = await pappId("framework-probe-second", proposer);
  await context.grantPermissions(["geolocation"], { origin: base })
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state)).toBe("granted")
  await page.evaluate(() => localStorage.setItem("source-secret", "private"))
  await page.evaluate(() => localStorage.setItem("framework-token", "fixture-state"));
  const sourceStorage = await page.evaluate(() => localStorage.getItem("framework-token"))
  // Hold a real asset request while publishing a newer release. Mixing is
  // accepted, but publication must not prevent the in-flight page loading.
  await page.evaluate(async () => { await fetch('/__papp/config', { method: 'POST', body: JSON.stringify({ server: 'https://localhost:3002' }) }) })
  const held = gateway.holdAsset('config.js');
  const loadingPage = await context.newPage()
  const navigation = loadingPage.goto(base)
  try {
    await Promise.race([held.arrived, Bun.sleep(20000).then(() => { throw new Error("asset request did not reach provider") })])
    await gateway.publish(2)
  } finally { held.release() }
  await navigation
  await browserExpect(loadingPage.locator("#daily-budget")).toHaveText("500000", { timeout: 60000 })
  await loadingPage.close()
  const response = await page.reload()
  expect(response!.headers()["x-paid-release"]).toBe("2")
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state)).toBe("granted")
  expect(await page.evaluate(() => localStorage.getItem("framework-token"))).toBe(sourceStorage)
  await browserExpect(page.locator("#daily-budget")).toHaveText("500000")
  const before = gateway.configurationBounces
  await page.evaluate(async ({ second, rendering }) => {
    const r = await fetch("https://paid.invalid/render?id=" + second, { headers: { "x-paid-functionality": JSON.stringify(rendering) } })
    if (!r.ok) throw new Error(await r.text())
    location.assign((await r.json()).url)
  }, { second, rendering })
  await page.waitForURL(`https://${second}.paid.localhost:3003/**`, { timeout: 60000 })
  await browserExpect(page.locator("#daily-budget")).toHaveText("1000000", { timeout: 60000 })
  expect(await page.evaluate(() => localStorage.getItem("source-secret"))).toBeNull()
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: "geolocation" })).state)).toBe("prompt")
  expect(gateway.configurationBounces).toBeGreaterThan(before)
  // The shared config origin supplies the address automatically on the second app.
  expect(await page.getByRole("heading", { name: "PAID configuration" }).count()).toBe(0)
  await page.goto(base)
  await browserExpect(page.locator("#daily-budget")).toHaveText("500000", { timeout: 60000 })
  gateway.restartUser()
  expect(gateway.user.budget(id, proposer).dailyBudget).toBe("500000")
  gateway.setUserOnline(false)
  await page.reload()
  await browserExpect(page.locator("body")).toContainText("User server", { timeout: 45000 })
  gateway.setUserOnline(true); await page.reload()
  await browserExpect(page.locator("#daily-budget")).toHaveText("500000", { timeout: 60000 })
  // Budget exhaustion is based on provider deposits.
  const { profile } = await page.evaluate(workerConfig)
  gateway.user.recordDeposit(profile, 500000n)
  expect(gateway.user.budget(id, proposer).remaining).toBe("0")
  const exhausted = await page.evaluate(async f => (await fetch("https://paid.invalid/kvstore.v1.MeteredStorageService/GetCASValue", { method: "POST", headers: { "x-paid-functionality": JSON.stringify(f), "content-type": "application/json" }, body: '{}' })).status, objects)
  expect(exhausted).toBe(402)
  // Increase the configured daily budget and recover without clearing browser state.
  await gateway.setDailyBudget("2000000")
  await page.reload(); await browserExpect(page.locator("#daily-budget")).toHaveText("1000000", { timeout: 60000 })
  // Invalid manifests still use valid content addresses and signed anchors.
  for (const [name, transform] of [
    ['framework-invalid-signature', (value: PappManifest) => ({ ...value, signature: value.signature.slice(0, -4) + 'AAAA' })],
    ['framework-wrong-identity', () => secondManifest],
  ] as const) {
    await page.goto(await gateway.invalidRelease(name, transform));
    await browserExpect(page.locator('body')).toContainText('No valid pApp release', { timeout: 60000 });
    expect(await page.evaluate(() => 'FRAMEWORK_PROBE' in globalThis)).toBe(false);
  }
  await page.goto(base);
  await browserExpect(page.locator('#daily-budget')).toHaveText('1000000', { timeout: 60000 });
  await page.evaluate(async () => { await fetch('/__papp/config', { method: 'POST', body: JSON.stringify({ server: 'https://localhost:3002' }) }) });
  gateway.setCorruptRoot(true);
  await page.reload(); await browserExpect(page.locator('body')).toContainText('Failed to load block');
  await browserExpect(page.locator('body')).toContainText('integrity mismatch');
  expect(await page.evaluate(() => 'FRAMEWORK_PROBE' in globalThis)).toBe(false);
  gateway.setCorruptRoot(false);
  await page.reload(); await browserExpect(page.locator('#daily-budget')).toHaveText('1000000', { timeout: 60000 });
}
