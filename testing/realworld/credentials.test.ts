import { expect, test } from "bun:test"
import { credentialScript } from "../../examples/realworld/credentials.ts"

test("another origin cannot load the local wallet as an executable script", async () => {
  for (const site of ["cross-site", "same-site"]) {
    const response = credentialScript(new Request("http://localhost:3001/client-key.js", { headers: { "sec-fetch-site": site } }), "globalThis.wallet='secret'", true)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain("secret")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
  }
})

test("the local origin can provision its wallet without caching credentials", async () => {
  const response = credentialScript(new Request("http://localhost:3001/client-key.js", { headers: { "sec-fetch-site": "same-origin" } }), "globalThis.wallet='secret'", true)
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("globalThis.wallet='secret'")
  expect(response.headers.get("cache-control")).toBe("no-store")
})

test("a different hostname resolving to loopback cannot provision the wallet", () => {
  const response = credentialScript(new Request("http://attacker.example/client-key.js", { headers: { "sec-fetch-site": "same-origin" } }), "secret", true)
  expect(response.status).toBe(403)
})
