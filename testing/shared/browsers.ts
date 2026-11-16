import { chromium, firefox, webkit, type BrowserContext } from "playwright"
import { mkdtemp, rm } from "node:fs/promises"

export const pappBrowsers = ["chrome", "firefox", "edge", "webkit"] as const
export type PappBrowser = typeof pappBrowsers[number]
export function selectedPappBrowser(): PappBrowser {
  const name = process.env.PAPP_BROWSER ?? "chrome"
  if (!pappBrowsers.includes(name as PappBrowser)) throw new Error(`Unsupported PAPP_BROWSER: ${name}`)
  return name as PappBrowser
}
async function run(...command: string[]) {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" })
  const error = await new Response(child.stderr).text()
  if (await child.exited) throw new Error(`${command[0]} failed: ${error}`)
}

// Firefox needs a trusted CA in its NSS profile; accepting a page's TLS warning
// or ignoreHTTPSErrors does not reliably trust service-worker script requests.
export async function launchBrowser(name: PappBrowser | "chromium", tls?: { ca: string; spki: string }): Promise<{ context: BrowserContext; close(): Promise<void> }> {
  if (name === "firefox" && tls) {
    const profile = await mkdtemp("/tmp/paid-firefox-")
    try {
      await run("certutil", "-N", "-d", `sql:${profile}`, "--empty-password")
      await run("certutil", "-A", "-d", `sql:${profile}`, "-n", "paid-fixture", "-t", "C,,", "-i", tls.ca)
      const context = await firefox.launchPersistentContext(profile)
      return { context, async close() { await context.close(); await rm(profile, { recursive: true, force: true }) } }
    } catch (error) {
      await rm(profile, { recursive: true, force: true }); throw error
    }
  }
  let trustedCA: string | undefined
  try {
    if (name === "webkit" && tls) {
      // Linux WebKitGTK reads the system CA store. This runs inside the test
      // container, and the temporary root is removed when the browser closes.
      trustedCA = `/usr/local/share/ca-certificates/paid-papp-${crypto.randomUUID()}.crt`
      await Bun.write(trustedCA, await Bun.file(tls.ca).arrayBuffer())
      await run("update-ca-certificates")
    }
    const browser = name === "webkit" ? await webkit.launch() : name === "firefox" ? await firefox.launch() : await chromium.launch({
      ...(name === "chrome" ? { channel: "chrome" } : name === "edge" ? { channel: "msedge" } : {}),
      args: ["--no-sandbox", ...(tls ? [`--ignore-certificate-errors-spki-list=${tls.spki}`] : [])],
    })
    try {
      const context = await browser.newContext()
      return { context, async close() {
        await browser.close()
        if (trustedCA) { await rm(trustedCA, { force: true }); await run("update-ca-certificates") }
      } }
    } catch (error) { await browser.close(); throw error }
  } catch (error) {
    if (trustedCA) { await rm(trustedCA, { force: true }); await run("update-ca-certificates") }
    throw error
  }
}
