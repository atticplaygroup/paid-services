import type { Page } from 'playwright';

// WebKit also reports canceled document fetches through Playwright's pageerror
// event ("due to access control checks"). Observe the browser's JavaScript
// error events instead, without suppressing errors or rejected promises.
export async function captureBrowserErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  await page.exposeBinding('__paidReportBrowserError', (_source, message: string) => { errors.push(message); });
  await page.addInitScript(() => {
    const report = (value: unknown) => {
      const message = value instanceof Error ? value.message : String(value);
      void (globalThis as any).__paidReportBrowserError(message).catch(() => {});
    };
    addEventListener('error', event => report(event.error ?? event.message));
    addEventListener('unhandledrejection', event => report(event.reason));
  });
  return errors;
}
