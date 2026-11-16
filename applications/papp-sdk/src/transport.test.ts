import { expect, test } from "bun:test"
import { userConnection } from "./transport.ts"

test("outproxy preserves request bytes when Request.body is unavailable in Firefox", async () => {
  const NativeRequest = globalThis.Request
  class FirefoxRequest extends NativeRequest {}
  Object.defineProperty(FirefoxRequest.prototype, "body", { get: () => undefined })
  globalThis.Request = FirefoxRequest
  try {
    const remote = userConnection("https://user.test", { app: "app", proposer: "proposer", profile: "profile" }, (async (input, init) => {
      expect(String(input)).toBe("https://user.test/outproxy")
      const value = JSON.parse(String(init?.body))
      expect(value.url).toBe("https://provider.test/sql")
      expect(value.method).toBe("POST")
      expect(value.headers).toContainEqual(["content-type", "application/json"])
      expect(atob(value.body)).toBe('{"sql":"SELECT 1"}')
      return new Response("provider rejected query", { status: 400 })
    }) as typeof fetch)
    const response = await remote.outproxy("https://provider.test/sql", {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"sql":"SELECT 1"}',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("provider rejected query")
  } finally {
    globalThis.Request = NativeRequest
  }
})
