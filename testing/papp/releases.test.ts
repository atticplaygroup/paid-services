import { test, expect } from 'bun:test';
import { launchBrowser, selectedPappBrowser } from './browsers.ts';
import { frameworkFixture } from './fixture.ts';
import { bootstrap, lifecycle } from './scenarios.ts';

test('framework releases, budgets, recovery, origin isolation and invalid publications', async () => {
  for (const mode of ['kubo', 'paid']) {
    const { gateway, objects, balance } = await frameworkFixture();
    try {
      gateway.setMode(mode);
      const browser = await launchBrowser(selectedPappBrowser(), { ca: gateway.ca, spki: gateway.spki });
      try {
        const page = await browser.context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await bootstrap(gateway, page, mode, balance);
        expect((await page.evaluate(async () => (await fetch('/papp-manifest')).json())).name).toBe('framework-probe');
        await lifecycle(gateway, page, browser.context, objects);
        expect(errors).toEqual([]);
      } finally { await browser.close() }
    } finally { await gateway.close() }
  }
}, 360000);
