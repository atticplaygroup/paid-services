import { beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { Transaction } from "@mysten/sui/transactions"
import { Cashier } from "./lib.js"
import { createCashierApp } from "./server.js"
import type { CashierConfig, PaymentConfig } from "./config.js"
import type { CashierDeps } from "./cashier.js"
import { base64UrlDecode, base64UrlNoPadding, importDpopKeyPair, importDpopSeed, providerId, thumbprintFromJwk } from "./identity.js"
import { create, fromBinary, toBinary } from "@bufbuild/protobuf"
import { GetBalanceResponseSchema } from "./proto/gen/es/account/v1/account_pb.js"
import {
  ProviderManifestSchema,
  ProviderExchangeSchema,
} from "./proto/gen/es/cashier/v1/cashier_pb.js"
import {
  BuyPointsRequestSchema,
  BuyPointsResponseSchema,
  DepositRequestSchema,
  DepositResponseSchema,
  GetChallengeResponseSchema,
  ListPaymentMethodsResponseSchema,
  PaymentCoin,
  PaymentEnvironment,
} from "./proto/gen/es/exchange/v1/exchange_pb.js"
import { DepositOrCreateAccountRequestSchema, DepositOrCreateAccountResponseSchema } from "./proto/gen/es/account/v1/account_pb.js"
import { TimestampSchema } from "@bufbuild/protobuf/wkt"

const USER_ID = providerId(thumbprintFromJwk(await crypto.subtle.exportKey("jwk", (await importDpopSeed(new Uint8Array(32).fill(3))).publicKey)))
const UNKNOWN_USER_ID = providerId(thumbprintFromJwk(await crypto.subtle.exportKey("jwk", (await importDpopSeed(new Uint8Array(32).fill(5))).publicKey)))
const REQUEST_ID = crypto.randomUUID()

const payment: PaymentConfig = {
  paymentCoin: 1,
  paymentEnvironment: 4,
  mnemonic: "test test test test test test test test test test test junk",
}

const mainnetPayment: PaymentConfig = {
  paymentCoin: 1,
  paymentEnvironment: 1,
  mnemonic: "test test test test test test test test test test test junk",
}

const config: CashierConfig = {
  accounts: [{ principal: USER_ID, masterSecret: new Uint8Array(32).fill(3), payments: [payment, mainnetPayment] }],
  accountSalt: new Uint8Array(32).fill(4),
  defaultChainDepositAmount: 100n,
  defaultProviderDepositAmount: 10n,
  accountOriginOverrides: {},
  manifestOriginOverrides: {},
}


let providerManifestId: string | undefined

async function signedManifestParts(exchangeOrigin = "http://exchange.example:8088", environment = PaymentEnvironment.LOCALNET) {
  const seed = new Uint8Array(32).fill(9)
  const keypair = await importDpopKeyPair(await importDpopSeed(seed))
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
  const manifest = {
    version: "v1",
    exchanges: [{
      hosts: [exchangeOrigin],
      paymentCoin: PaymentCoin.SUI,
      paymentEnvironment: environment,
    }],
  }
  const unsigned = create(ProviderManifestSchema, {
    version: manifest.version,
    id: "",
    exchanges: manifest.exchanges.map((exchange) => create(ProviderExchangeSchema, exchange)),
    signature: "",
  })
  const thumbprint = thumbprintFromJwk(publicJwk)
  const id = providerId(thumbprint)
  const header = new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "PAID-provider-manifest", jwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } }))
  const payload = new TextEncoder().encode(JSON.stringify({ version: manifest.version, id, exchanges: manifest.exchanges }))
  const encodedHeader = base64UrlNoPadding(header)
  const encodedPayload = base64UrlNoPadding(payload)
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keypair.privateKey, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`))
  providerManifestId = id
  return {
    version: manifest.version,
    id,
    exchanges: manifest.exchanges,
    header: encodedHeader,
    payload: encodedPayload,
    signature: base64UrlNoPadding(new Uint8Array(signature)),
  }
}

async function signedProviderManifest(exchangeOrigin = "http://exchange.example:8088", environment = PaymentEnvironment.LOCALNET) {
  const manifest = await signedManifestParts(exchangeOrigin, environment)
  return JSON.stringify({ version: manifest.version, id: manifest.id, exchanges: manifest.exchanges, signature: `${manifest.header}.${manifest.payload}.${manifest.signature}` })
}

const deps = {
  fetch: async () => new Response("{}", { status: 404 }),
      suiClientFactory: () => ({ signAndExecuteTransaction: async () => ({ Transaction: { digest: "digest" } }), waitForTransaction: async () => ({ Transaction: { digest: "digest" } }) }),
} satisfies CashierDeps

function post(app: Hono, path: string, body: unknown, headers: HeadersInit = {}) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
}

describe("chain wallet inspection", () => {
  it("returns the configured wallet address and balance without funding or spending", async () => {
    const balance = "9007199254740993123"
    let owner: string | undefined
    const inspectDeps: CashierDeps = { suiClientFactory: (selected) => {
      expect(selected).toBe(payment)
      return {
        getBalance: async (input) => { owner = input.owner; return { balance: { balance } } },
        signAndExecuteTransaction: async () => { throw new Error("inspection must not transact") },
      }
    }, faucetRequest: async () => { throw new Error("inspection must not fund") } }
    const cashier = new Cashier(config, inspectDeps)
    const direct = await cashier.getChainBalance({ preferredPaymentCoin: 1, preferredPaymentEnvironment: 4 }, USER_ID)
    expect(direct.address).toBe("0xc88ef07b9b8b2fc3b7daad9478f4e1337f01792e2eab9c3794494e610636026e")
    expect(direct.balance).toBe(balance)
    expect(owner).toBe(direct.address)
    const response = await post(createCashierApp(config, inspectDeps), "/cashier.v1.CashierService/GetChainBalance", {
      preferredPaymentCoin: "PAYMENT_COIN_SUI", preferredPaymentEnvironment: "PAYMENT_ENVIRONMENT_LOCALNET",
    }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ address: direct.address, balance })
  })

  it("reports balance failures without funding the wallet", async () => {
    const inspectDeps: CashierDeps = { suiClientFactory: () => ({
      getBalance: async () => { throw new Error("chain unavailable") },
      signAndExecuteTransaction: async () => { throw new Error("unexpected transaction") },
    }) }
    const response = await post(createCashierApp(config, inspectDeps), "/cashier.v1.CashierService/GetChainBalance", {
      preferredPaymentCoin: 1, preferredPaymentEnvironment: 4,
    }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("chain unavailable")
    await expect(new Cashier(config, deps).getChainBalance({ preferredPaymentCoin: 1, preferredPaymentEnvironment: 4 }, USER_ID)).rejects.toThrow("SUI client cannot check wallet balance")
  })

  it.each([
    { headers: {}, environment: 4, status: 401 },
    { headers: { "x-user-id": USER_ID }, environment: 4, status: 400 },
    { headers: { "x-user-id": UNKNOWN_USER_ID, "x-request-id": REQUEST_ID }, environment: 4, status: 403 },
    { headers: { "x-user-id": USER_ID, "x-request-id": REQUEST_ID }, environment: 3, status: 400 },
  ])("rejects invalid inspection requests: %j", async ({ headers, environment, status }) => {
    const response = await post(createCashierApp(config, deps), "/cashier.v1.CashierService/GetChainBalance", {
      preferredPaymentCoin: 1, preferredPaymentEnvironment: environment,
    }, headers as Record<string, string>)
    expect(response.status).toBe(status)
  })
})

describe("cashier provider manifest validation", () => {
  it.each([
    { requestOrigin: "http://provider.example:8080", overrideHost: "http://provider.example:8080" },
    { requestOrigin: "http://provider.example:8080", overrideHost: "provider.example:8080" },
    { requestOrigin: "http://provider.example:8080", overrideHost: "provider.example" },
    { requestOrigin: "http://provider.example:8080", overrideHost: undefined },
    { requestOrigin: "https://provider.example:8443", overrideHost: undefined },
  ])("fetches a signed manifest for %j", async ({ requestOrigin, overrideHost }) => {
    const expectedOrigin = overrideHost ? "https://manifest.example:8443" : requestOrigin
    const manifest = JSON.parse(await signedProviderManifest())
    manifest.exchanges[0].paymentCoin = PaymentCoin.UNSPECIFIED
    const urls: string[] = []
    const fetch: CashierDeps["fetch"] = async (input) => {
      const url = input instanceof URL ? input.href : String(input)
      urls.push(url)
      if (url.endsWith("/GetBalance")) return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 0n })), { headers: { "Content-Type": "application/proto" } })
      if (url === `${expectedOrigin}/.well-known/paid_provider_manifest.json`) return Response.json(manifest)
      throw new Error(`unexpected URL: ${url}`)
    }
    const app = createCashierApp({ ...config, manifestOriginOverrides: overrideHost ? { [overrideHost]: "https://manifest.example:8443/" } : {} }, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: `${requestOrigin}/path`, htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(await response.text()).toContain("no exchange supported by cashier")
    expect(urls).toContain(`${expectedOrigin}/.well-known/paid_provider_manifest.json`)
  })

  it("rejects a tampered manifest signature", async () => {
    const { header, payload, signature } = await signedManifestParts()
    const tamperedSignature = base64UrlNoPadding(new Uint8Array(64).fill(1))
    const manifest = JSON.stringify({ signature: `${header}.${payload}.${tamperedSignature}` })
    const fetch: CashierDeps["fetch"] = async (input) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 0n })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) return new Response(manifest, { status: 200, headers: { "Content-Type": "application/json" } })
      throw new Error(`unexpected URL: ${url}`)
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("provider manifest signature verification failed")
  })

  it("rejects a provider with no exchange supported by cashier", async () => {
    const manifest = await signedProviderManifest()
    const parsed = JSON.parse(manifest)
    parsed.exchanges[0].paymentCoin = PaymentCoin.UNSPECIFIED
    const fetch: CashierDeps["fetch"] = async (input) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 0n })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) return new Response(JSON.stringify(parsed), { status: 200, headers: { "Content-Type": "application/json" } })
      throw new Error(`unexpected URL: ${url}`)
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("no exchange supported by cashier")
  })
})

describe("cashier service", () => {
  let app: Hono
  beforeEach(() => { app = createCashierApp(config, deps) })

  it("returns 401 without trusted principal", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" })
    expect(response.status).toBe(401)
  })

  it("returns 403 for unknown principal", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": UNKNOWN_USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(403)
  })

  it("returns 400 without request id", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID })
    expect(response.status).toBe(400)
  })

  it("rejects mainnet faucet in trusted mode", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetFunds", { preferredPaymentCoin: 1, preferredPaymentEnvironment: 1 }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(501)
  })

  it("calls configured local faucet for non-mainnet", async () => {
    let requested: { recipient?: string } | undefined
    const faucetApp = createCashierApp(config, { ...deps, faucetRequest: async (_payment, recipient) => { requested = { recipient } } })
    const response = await faucetApp.request("/cashier.v1.CashierService/GetFunds", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": USER_ID, "x-request-id": REQUEST_ID },
      body: JSON.stringify({ preferredPaymentCoin: 1, preferredPaymentEnvironment: 4 }),
    })
    expect(response.status).toBe(200)
    expect(requested?.recipient).toStartWith("0x")
  })

  it("rejects GetFunds without a matching payment configuration", async () => {
    let faucetCalled = false
    const app = createCashierApp(config, { ...deps, faucetRequest: async () => { faucetCalled = true } })
    const response = await post(app, "/cashier.v1.CashierService/GetFunds", {
      preferredPaymentCoin: 0,
      preferredPaymentEnvironment: 4,
    }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("no matching payment configuration")
    expect(faucetCalled).toBe(false)
  })
})

describe("cashier funding flow", () => {
  it("returns an existing DPoP proof when provider balance is positive", async () => {
    let balanceProof: string | undefined
    let forwardedHtu: string | undefined
    const fetch: CashierDeps["fetch"] = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url === "https://account.provider.example/account.v1.AccountService/GetBalance") {
        balanceProof = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length)
        forwardedHtu = JSON.parse(new TextDecoder().decode(base64UrlDecode(balanceProof!.split(".")[1]))).htu
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 1n })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      return new Response("unexpected", { status: 500 })
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.accessToken.split(".")).toHaveLength(3)
    expect(payload.accessToken.split(".")[0]).toBe(balanceProof!.split(".")[0])
    const tokenClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload.accessToken.split(".")[1])))
    expect(tokenClaims.htm).toBe("GET")
    expect(tokenClaims.htu).toBe("http://provider.example/path")
    expect(forwardedHtu).toBe("https://account.provider.example/account.v1.AccountService/GetBalance")
  })
})


describe("cashier provider funding flow", () => {
  it.each(["http://exchange.example:8088", "https://exchange.example:8443"])("buys usage tokens at the advertised origin %s and deposits them to the provider", async (exchangeOrigin) => {
    const balanceResponses = new Map<string, bigint>([
      ["https://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["https://account.exchange.example/account.v1.AccountService/GetBalance", 20n],
    ])
    let transferredTo: string | undefined
        const fetch: CashierDeps["fetch"] = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        const message = balanceResponses.get(url)
        if (message === undefined) throw new Error(`unexpected balance URL: ${url}`)
        const response = create(GetBalanceResponseSchema, { balance: message })
        return new Response(toBinary(GetBalanceResponseSchema, response), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/ListPaymentMethods")) {
        transferredTo = "0x" + "1".repeat(64)
        return new Response(toBinary(ListPaymentMethodsResponseSchema, create(ListPaymentMethodsResponseSchema, {
          paymentMethods: [{ coin: PaymentCoin.SUI, environment: PaymentEnvironment.LOCALNET, address: "0x" + "1".repeat(64) }],
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/GetChallenge")) {
        return new Response(toBinary(GetChallengeResponseSchema, create(GetChallengeResponseSchema, {
          challenge: new TextEncoder().encode("challenge"),
          startTime: create(TimestampSchema, { seconds: 1n }),
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/Deposit")) {
        const request = fromBinary(DepositRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())

        return new Response(toBinary(DepositResponseSchema, create(DepositResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/BuyPoints")) {
        expect(url).toBe(`${exchangeOrigin}/exchange.v1.ExchangeService/BuyPoints`)
        const headers = new Headers(init?.headers)
        const proof = headers.get("Authorization")!.slice("Bearer ".length)
        const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(proof.split(".")[1])))
        expect(claims.htu).toBe(url)
        expect(claims.htm).toBe("POST")
        const request = fromBinary(BuyPointsRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        const expectedAudience = providerManifestId
        if (!expectedAudience) throw new Error("provider manifest id is missing")
        expect(request.audience).toBe(expectedAudience)
        expect(request.amount).toBe(10n)
        return new Response(toBinary(BuyPointsResponseSchema, create(BuyPointsResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        const depositRequest = fromBinary(DepositOrCreateAccountRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        expect(depositRequest.jwt).toBe("usage-token")
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)
        expect(headers.get("Authorization")).toStartWith("Bearer ")
        expect(headers.get("x-request-id")).not.toBe(REQUEST_ID)
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) {
        return new Response(await signedProviderManifest(exchangeOrigin), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response("unexpected", { status: 500 })
    }
    const suiClientFactory: CashierDeps["suiClientFactory"] = () => ({
      signAndExecuteTransaction: async ({ transaction }) => {
        expect(transaction).toBeInstanceOf(Transaction)
        return { $kind: "Transaction", Transaction: { digest: "a".repeat(44) } } as never
      },
      waitForTransaction: async ({ digest, timeout }) => {
        expect(digest).toBe("a".repeat(44))
        expect(timeout).toBe(20_000)
        return { Transaction: { digest } }
      },
    })
    const app = createCashierApp(config, { fetch, suiClientFactory })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    if (response.status !== 200) console.log("response", response.status, await response.text())
    expect(response.status).toBe(200)
  })

  it("caps the purchased amount at the exchange balance", async () => {
    const balanceResponses = new Map<string, bigint>([
      ["https://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["https://account.exchange.example/account.v1.AccountService/GetBalance", 7n],
    ])
    let purchasedAmount: bigint | undefined
    const fetch: CashierDeps["fetch"] = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        const balance = balanceResponses.get(url)
        if (balance === undefined) throw new Error(`unexpected balance URL: ${url}`)
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/BuyPoints")) {
        const request = fromBinary(BuyPointsRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        purchasedAmount = request.amount
        return new Response(toBinary(BuyPointsResponseSchema, create(BuyPointsResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) return new Response(await signedProviderManifest(), { status: 200, headers: { "Content-Type": "application/json" } })
      throw new Error(`unexpected URL: ${url}`)
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(response.status).toBe(200)
    expect(purchasedAmount).toBe(7n)
  })
})

describe("cashier exchange deposit", () => {
  for (const scenario of [
    { name: "mainnet", enabled: true, initial: 0n, faucetFails: false },
    { name: "testnet", enabled: false, initial: 0n, faucetFails: false },
    { name: "devnet", enabled: false, initial: 0n, faucetFails: false },
    { name: "failed confirmation", enabled: false, initial: 0n, faucetFails: false },
    { name: "disabled", enabled: false, initial: 0n, faucetFails: false },
    { name: "empty wallet", enabled: true, initial: 0n, faucetFails: false },
    { name: "delayed funds", enabled: true, initial: 0n, faucetFails: false },
    { name: "funded wallet", enabled: true, initial: 1_000_000_000n, faucetFails: false },
    { name: "faucet unavailable", enabled: true, initial: 0n, faucetFails: true },
  ]) it(`transfers with lazy faucet: ${scenario.name}`, async () => {
    const environment = scenario.name === "mainnet" ? PaymentEnvironment.MAINNET
      : scenario.name === "testnet" ? PaymentEnvironment.TESTNET
      : scenario.name === "devnet" ? PaymentEnvironment.DEVNET : PaymentEnvironment.LOCALNET
    let walletBalance = scenario.initial
    let faucetCalls = 0
    let pendingBalanceReads = 0
    const scenarioConfig = { ...config, accounts: [{ ...config.accounts[0], payments: [{ ...payment, paymentEnvironment: environment, autoFaucet: scenario.enabled, suiRpcUrl: "http://wallet-rpc.example:9000" }] }] }

    const balanceResponses = new Map<string, bigint>([
      ["https://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["https://account.exchange.example/account.v1.AccountService/GetBalance", 0n],
    ])
    let depositProof: ReturnType<typeof fromBinary<typeof DepositRequestSchema>>["proof"] | undefined
    let depositCompleted = false
    let transactionAmount: bigint | undefined
    let recipient: string | undefined
    const fetch: CashierDeps["fetch"] = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        const balance = balanceResponses.get(url)
        if (balance === undefined) throw new Error(`unexpected balance URL: ${url}`)
        const effectiveBalance = depositCompleted && url.includes("exchange.example") ? 20n : balance
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: effectiveBalance })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/ListPaymentMethods")) {
        expect(url).toBe("http://exchange.example:8088/exchange.v1.ExchangeService/ListPaymentMethods")
        recipient = "0x" + "1".repeat(64)
        return new Response(toBinary(ListPaymentMethodsResponseSchema, create(ListPaymentMethodsResponseSchema, {
          paymentMethods: [{ coin: PaymentCoin.SUI, environment, address: recipient }],
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/GetChallenge")) {
        expect(url).toBe("http://exchange.example:8088/exchange.v1.ExchangeService/GetChallenge")
        return new Response(toBinary(GetChallengeResponseSchema, create(GetChallengeResponseSchema, {
          challenge: new TextEncoder().encode("challenge"),
          startTime: create(TimestampSchema, { seconds: 1n }),
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/Deposit")) {
        expect(url).toBe("http://exchange.example:8088/exchange.v1.ExchangeService/Deposit")
        depositProof = fromBinary(DepositRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array()).proof
        depositCompleted = true
        return new Response(toBinary(DepositResponseSchema, create(DepositResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) {
        return new Response(await signedProviderManifest(undefined, environment), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url.endsWith("/BuyPoints")) {
        return new Response(toBinary(BuyPointsResponseSchema, create(BuyPointsResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }
    const suiClientFactory: CashierDeps["suiClientFactory"] = (configuredPayment) => {
      expect(configuredPayment.paymentEnvironment).toBe(environment)
      expect(configuredPayment.suiRpcUrl).toBe("http://wallet-rpc.example:9000")
      return {
        getBalance: async () => {
          if (pendingBalanceReads > 0 && --pendingBalanceReads === 0) walletBalance = 1_000_000_000n
          return { balance: { balance: walletBalance.toString() } }
        },
        signAndExecuteTransaction: async ({ transaction, signer }) => {
          expect(transaction).toBeInstanceOf(Transaction)
          transactionAmount = 100n
          recipient = signer.toSuiAddress()
          return { $kind: "Transaction", Transaction: { digest: "a".repeat(44) } } as never
        },
        waitForTransaction: async ({ digest, timeout }) => {
          expect(digest).toBe("a".repeat(44))
          expect(timeout).toBe(20_000)
          return scenario.name === "failed confirmation" ? { FailedTransaction: { digest } } : { Transaction: { digest } }
        },
      }
    }
    const app = createCashierApp(scenarioConfig, { fetch, suiClientFactory, faucetRequest: async () => {
      faucetCalls++
      if (scenario.faucetFails && faucetCalls === 1) throw new Error("faucet unavailable")
      if (scenario.name === "delayed funds") pendingBalanceReads = 2
      else walletBalance = 1_000_000_000n
    } })
    const inspect = async () => {
      const response = await post(app, "/cashier.v1.CashierService/GetChainBalance", {
        preferredPaymentCoin: PaymentCoin.SUI, preferredPaymentEnvironment: environment,
      }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
      expect(response.status).toBe(200)
      return await response.json() as { address: string; balance: string }
    }
    const initialWallet = await inspect()
    expect(BigInt(initialWallet.balance)).toBe(scenario.initial)
    expect(faucetCalls).toBe(0)
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": REQUEST_ID })
    expect(faucetCalls).toBe(scenario.enabled && environment !== PaymentEnvironment.MAINNET && scenario.initial === 0n ? 1 : 0)
    if (scenario.faucetFails) {
      expect(response.status).toBe(400)
      expect(transactionAmount).toBeUndefined()
      const retry = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": USER_ID, "x-request-id": crypto.randomUUID() })
      expect(retry.status).toBe(200)
      expect(faucetCalls).toBe(2)
      expect(depositCompleted).toBe(true)
      return
    }
    if (scenario.name === "failed confirmation") {
      expect(response.status).toBe(400)
      expect(depositCompleted).toBe(false)
      expect(depositProof).toBeUndefined()
      return
    }
    expect(response.status).toBe(200)
    expect(transactionAmount).toBe(100n)
    expect(recipient).toBe(initialWallet.address)
    expect(BigInt((await inspect()).balance)).toBe(walletBalance)
    expect(depositProof?.chainDigest).toBe("a".repeat(44))
    expect(depositProof?.challenge).toEqual(new TextEncoder().encode("challenge"))
    expect(depositProof?.signature).toBeDefined()
  })
})
