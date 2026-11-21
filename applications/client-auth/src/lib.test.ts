import { test, expect } from "bun:test"
import { generateKeyPair } from "dpop"
import { createAuthenticatedFetch, DirectAccessTokenProvider, CashierAccessTokenProvider, AccessTokenError } from "./lib.ts"

test("auth binds to final URL, strips query/fragment from proof, and preserves the request", async () => {
  const key = await generateKeyPair("ES256")
  const requests: Request[] = []
  const auth = createAuthenticatedFetch(key, (async input => {
    requests.push(input as Request)
    return new Response("ok")
  }) as typeof fetch)
  for (let i = 0; i < 2; i++) await auth(new Request("https://provider.example/echo?q=1#fragment", {
    method: "POST", headers: { "content-type": "application/json", "x-operation": "echo" }, body: '{"message":"hello"}',
  }))
  const claims = requests.map(request => JSON.parse(Buffer.from(request.headers.get("authorization")!.split(".")[1], "base64url").toString()))
  expect(claims[0].htu).toBe("https://provider.example/echo")
  expect(claims[0].htm).toBe("POST")
  expect(claims[0].jti).not.toBe(claims[1].jti)
  expect(requests[0].headers.get("x-operation")).toBe("echo")
  expect(await requests[0].text()).toBe('{"message":"hello"}')
  expect(requests[0].redirect).toBe("error")
  const [header, payload, signature] = requests[0].headers.get("authorization")!.slice(7).split(".")
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.publicKey,
    Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${payload}`))).toBe(true)
})


test("shared direct provider preserves the root path in request-bound proofs", async () => {
  const provider = new DirectAccessTokenProvider(await generateKeyPair("ES256"))
  const token = await provider.getAccessToken({ url: "https://provider.example/?q=1#fragment", method: "GET", headers: new Headers() })
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
  expect(claims.htu).toBe("https://provider.example/")
})

test("interceptor uses the shared cashier provider and stops on token failure", async () => {
  const cashierCalls: Request[] = []
  let fail = false
  const provider = new CashierAccessTokenProvider("https://cashier.example", "customer", (async (input, init) => {
    cashierCalls.push(new Request(input, init))
    return fail ? new Response("unfunded", { status: 403 }) : Response.json({ accessToken: "cashier-proof" })
  }) as typeof fetch)
  const forwarded: Request[] = []
  const auth = createAuthenticatedFetch(provider, (async request => {
    forwarded.push(request as Request)
    return new Response("ok")
  }) as typeof fetch)
  await auth("https://provider.example/echo", { method: "POST", headers: { "x-request-id": "operation-1" }, body: "hello" })
  expect(cashierCalls[0].headers.get("x-user-id")).toBe("customer")
  expect(cashierCalls[0].headers.get("x-request-id")).toBe("operation-1")
  expect((await cashierCalls[0].json()).htu).toBe("https://provider.example/echo")
  expect(forwarded[0].headers.get("authorization")).toBe("Bearer cashier-proof")
  fail = true
  await expect(auth("https://provider.example/echo")).rejects.toBeInstanceOf(AccessTokenError)
  expect(forwarded).toHaveLength(1)
})
