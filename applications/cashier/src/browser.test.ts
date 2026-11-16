import { expect, test } from "bun:test"
import { create, toBinary } from "@bufbuild/protobuf"
import { BrowserCashierAccessTokenProvider } from "./browser.js"
import { parseCashierConfig } from "./config.js"
import { base64UrlDecode } from "./identity.js"
import { GetBalanceResponseSchema } from "./proto/gen/es/account/v1/account_pb.js"

test("browser adapter serializes requests, recovers after failure, and binds proofs to each destination", async () => {
  const config = parseCashierConfig(JSON.stringify({ accounts: [{
    principal: "browser-user",
    masterSecretMnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
    payments: [{ mnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow" }],
  }] }))
  let active = 0, maxActive = 0, fail = true
  const adapter = new BrowserCashierAccessTokenProvider(config, "browser-user", config.accounts[0].payments[0], (async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("https://account.provider.example/account.v1.AccountService/GetBalance")
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    if (fail) { fail = false; throw new Error("temporary outage") }
    return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 1n })), { headers: { "Content-Type": "application/proto" } })
  }) as typeof fetch)
  const request = (path: string) => adapter.getAccessToken({ url: `https://provider.example/${path}?query=1`, method: "POST", headers: new Headers() })
  const results = await Promise.allSettled([request("first"), request("second"), request("third")])
  expect(results[0].status).toBe("rejected")
  for (const [index, path] of [[1, "second"], [2, "third"]] as const) {
    const result = results[index]
    expect(result.status).toBe("fulfilled")
    if (result.status !== "fulfilled") throw result.reason
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(result.value.split(".")[1])))
    expect(claims.htu).toBe(`https://provider.example/${path}`)
    expect(claims.htm).toBe("POST")
  }
  expect(maxActive).toBe(1)
})
