import { test, expect } from "bun:test"
import { chromium } from "playwright"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { packFrontend } from "../../proposer/app-packer/index.ts"

test("shared client-auth library signs requests in a browser without server dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "client-auth-browser-"))
  const browser = await chromium.launch({ args: ["--no-sandbox"] })
  try {
    const entry = join(directory, "entry.ts")
    const library = new URL("../../applications/client-auth/src/lib.ts", import.meta.url).pathname
    await Bun.write(entry, `
      import { createAuthenticatedFetch, DirectAccessTokenProvider } from ${JSON.stringify(library)};
      const key = await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign","verify"]);
      const auth = createAuthenticatedFetch(new DirectAccessTokenProvider(key), async request => {
        const token = request.headers.get("authorization").slice(7);
        const [header,payload,signature] = token.split(".");
        const decode = part => Uint8Array.from(atob(part.replace(/-/g,"+").replace(/_/g,"/")), c=>c.charCodeAt(0));
        const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
        const valid = await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},key.publicKey,decode(signature),new TextEncoder().encode(header+"."+payload));
        document.body.textContent = JSON.stringify({valid,htu:claims.htu,method:claims.htm,body:await request.text()});
        return new Response("ok");
      });
      await auth("https://provider.example/echo?q=1#fragment",{method:"POST",body:"hello"});
    `)
    const files = await packFrontend(entry, {})
    const html = join(directory, "index.html")
    await Bun.write(html, files["index.html"])
    const page = await browser.newPage()
    await page.goto(pathToFileURL(html).href)
    await page.waitForFunction(() => document.body.textContent?.startsWith("{"))
    expect(JSON.parse(await page.locator("body").innerText())).toEqual({ valid: true, htu: "https://provider.example/echo", method: "POST", body: "hello" })
  } finally {
    await browser.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
