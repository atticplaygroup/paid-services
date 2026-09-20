import { beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { Transaction } from "@mysten/sui/transactions"
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
  BuyTokenRequestSchema,
  BuyTokenResponseSchema,
  DepositRequestSchema,
  DepositResponseSchema,
  GetChallengeResponseSchema,
  ListPaymentMethodsResponseSchema,
  PaymentCoin,
  PaymentEnvironment,
} from "./proto/gen/es/exchange/v1/exchange_pb.js"
import { DepositOrCreateAccountRequestSchema, DepositOrCreateAccountResponseSchema } from "./proto/gen/es/account/v1/account_pb.js"
import { TimestampSchema } from "@bufbuild/protobuf/wkt"

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
  accounts: [{ principal: "alice", masterSecret: new Uint8Array(32).fill(3), payments: [payment, mainnetPayment] }],
  accountSalt: new Uint8Array(32).fill(4),
  insecure: true,
  defaultChainDepositAmount: 100n,
  defaultProviderDepositAmount: 10n,
  accountOriginOverrides: {},
  exchangeOriginOverrides: {},
}


let providerManifestId: string | undefined

async function signedManifestParts() {
  const seed = new Uint8Array(32).fill(9)
  const keypair = await importDpopKeyPair(await importDpopSeed(seed))
  const publicJwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
  const manifest = {
    version: "v1",
    exchanges: [{
      hosts: ["http://exchange.example"],
      paymentCoin: PaymentCoin.SUI,
      paymentEnvironment: PaymentEnvironment.LOCALNET,
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

async function signedProviderManifest() {
  const manifest = await signedManifestParts()
  return JSON.stringify({ version: manifest.version, id: manifest.id, exchanges: manifest.exchanges, signature: `${manifest.header}.${manifest.payload}.${manifest.signature}` })
}

const deps = {
  fetch: async () => new Response("{}", { status: 404 }),
      suiClientFactory: () => ({ signAndExecuteTransaction: async () => ({ digest: "digest" }), waitForTransaction: async () => undefined }),
} satisfies CashierDeps

function post(app: Hono, path: string, body: unknown, headers: HeadersInit = {}) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
}

describe("cashier provider manifest validation", () => {
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
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
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
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
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
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "unknown", "x-request-id": "request" })
    expect(response.status).toBe(403)
  })

  it("returns 400 without request id", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice" })
    expect(response.status).toBe(400)
  })

  it("rejects mainnet faucet in trusted mode", async () => {
    const response = await post(app, "/cashier.v1.CashierService/GetFunds", { preferredPaymentCoin: 1, preferredPaymentEnvironment: 1 }, { "x-user-id": "alice", "x-request-id": "request" })
    expect(response.status).toBe(501)
  })

  it("calls configured local faucet for non-mainnet", async () => {
    let requested: { recipient?: string } | undefined
    const faucetApp = createCashierApp(config, { ...deps, faucetRequest: async (_payment, recipient) => { requested = { recipient } } })
    const response = await faucetApp.request("/cashier.v1.CashierService/GetFunds", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": "alice", "x-request-id": "request" },
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
    }, { "x-user-id": "alice", "x-request-id": "request" })
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
      if (url === "http://account.provider.example/account.v1.AccountService/GetBalance") {
        balanceProof = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length)
        forwardedHtu = JSON.parse(new TextDecoder().decode(base64UrlDecode(balanceProof!.split(".")[1]))).htu
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance: 1n })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      return new Response("unexpected", { status: 500 })
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.accessToken.split(".")).toHaveLength(3)
    expect(payload.accessToken.split(".")[0]).toBe(balanceProof!.split(".")[0])
    const tokenClaims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload.accessToken.split(".")[1])))
    expect(tokenClaims.htm).toBe("GET")
    expect(tokenClaims.htu).toBe("http://provider.example/path")
    expect(forwardedHtu).toBe("http://account.provider.example/account.v1.AccountService/GetBalance")
  })
})


describe("cashier provider funding flow", () => {
  it("buys usage tokens and deposits them to the provider", async () => {
    const balanceResponses = new Map<string, bigint>([
      ["http://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["http://account.exchange.example/account.v1.AccountService/GetBalance", 20n],
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
      if (url.endsWith("/BuyToken")) {
        const request = fromBinary(BuyTokenRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        const expectedAudience = providerManifestId
        if (!expectedAudience) throw new Error("provider manifest id is missing")
        expect(request.audience).toBe(expectedAudience)
        expect(request.amount).toBe(10n)
        return new Response(toBinary(BuyTokenResponseSchema, create(BuyTokenResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        const depositRequest = fromBinary(DepositOrCreateAccountRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        expect(depositRequest.jwt).toBe("usage-token")
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)
        expect(headers.get("Authorization")).toStartWith("Bearer ")
        expect(headers.get("x-request-id")).not.toBe("request")
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) {
        return new Response(await signedProviderManifest(), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url === "https://graphql.devnet.sui.io/graphql") {
        const body = JSON.parse(init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body)) as { query?: string }
        expect(body.query).toContain('digest: "' + "a".repeat(44) + '"')
        return new Response(JSON.stringify({ data: { transaction: { effects: { status: "SUCCESS" } } } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      return new Response("unexpected", { status: 500 })
    }
    const suiClientFactory: CashierDeps["suiClientFactory"] = () => ({
      signAndExecuteTransaction: async ({ transaction }) => {
        expect(transaction).toBeInstanceOf(Transaction)
        return { $kind: "Transaction", Transaction: { digest: "a".repeat(44) } } as never
      },
      waitForTransaction: undefined,
    })
    const app = createCashierApp(config, { fetch, suiClientFactory })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
    if (response.status !== 200) console.log("response", response.status, await response.text())
    expect(response.status).toBe(200)
  })

  it("caps the purchased amount at the exchange balance", async () => {
    const balanceResponses = new Map<string, bigint>([
      ["http://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["http://account.exchange.example/account.v1.AccountService/GetBalance", 7n],
    ])
    let purchasedAmount: bigint | undefined
    const fetch: CashierDeps["fetch"] = async (input, init) => {
      const url = input instanceof URL ? input.href : String(input)
      if (url.endsWith("/GetBalance")) {
        const balance = balanceResponses.get(url)
        if (balance === undefined) throw new Error(`unexpected balance URL: ${url}`)
        return new Response(toBinary(GetBalanceResponseSchema, create(GetBalanceResponseSchema, { balance })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/BuyToken")) {
        const request = fromBinary(BuyTokenRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array())
        purchasedAmount = request.amount
        return new Response(toBinary(BuyTokenResponseSchema, create(BuyTokenResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) return new Response(await signedProviderManifest(), { status: 200, headers: { "Content-Type": "application/json" } })
      throw new Error(`unexpected URL: ${url}`)
    }
    const app = createCashierApp(config, { fetch })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
    expect(response.status).toBe(200)
    expect(purchasedAmount).toBe(7n)
  })
})

describe("cashier exchange deposit", () => {
  it("transfers the configured amount and submits a challenge-bound proof", async () => {
    const balanceResponses = new Map<string, bigint>([
      ["http://account.provider.example/account.v1.AccountService/GetBalance", 0n],
      ["http://account.exchange.example/account.v1.AccountService/GetBalance", 0n],
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
        recipient = "0x" + "1".repeat(64)
        return new Response(toBinary(ListPaymentMethodsResponseSchema, create(ListPaymentMethodsResponseSchema, {
          paymentMethods: [{ coin: PaymentCoin.SUI, environment: PaymentEnvironment.LOCALNET, address: recipient }],
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/GetChallenge")) {
        return new Response(toBinary(GetChallengeResponseSchema, create(GetChallengeResponseSchema, {
          challenge: new TextEncoder().encode("challenge"),
          startTime: create(TimestampSchema, { seconds: 1n }),
        })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/Deposit")) {
        depositProof = fromBinary(DepositRequestSchema, init?.body instanceof Uint8Array ? init.body : new Uint8Array()).proof
        depositCompleted = true
        return new Response(toBinary(DepositResponseSchema, create(DepositResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.endsWith("/DepositOrCreateAccount")) {
        return new Response(toBinary(DepositOrCreateAccountResponseSchema, create(DepositOrCreateAccountResponseSchema, {})), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url.includes("/.well-known/paid_provider_manifest.json")) {
        return new Response(await signedProviderManifest(), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      if (url.endsWith("/BuyToken")) {
        return new Response(toBinary(BuyTokenResponseSchema, create(BuyTokenResponseSchema, { token: "usage-token" })), { status: 200, headers: { "Content-Type": "application/proto" } })
      }
      if (url === "https://graphql.devnet.sui.io/graphql") {
        return new Response(JSON.stringify({ data: { transaction: { effects: { status: "SUCCESS" } } } }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }
    const suiClientFactory: CashierDeps["suiClientFactory"] = () => ({
      signAndExecuteTransaction: async ({ transaction, signer }) => {
        expect(transaction).toBeInstanceOf(Transaction)
        transactionAmount = 100n
        recipient = signer.toSuiAddress()
        return { $kind: "Transaction", Transaction: { digest: "a".repeat(44) } } as never
      },
      waitForTransaction: undefined,
    })
    const app = createCashierApp(config, { fetch, suiClientFactory })
    const response = await post(app, "/cashier.v1.CashierService/GetAccessToken", { htu: "http://provider.example/path", htm: "GET" }, { "x-user-id": "alice", "x-request-id": "request" })
    if (response.status !== 200) console.log("response", response.status, await response.text())
    expect(response.status).toBe(200)
    expect(transactionAmount).toBe(100n)
    expect(recipient).toBeDefined()
    expect(depositProof?.chainDigest).toBe("a".repeat(44))
    expect(depositProof?.challenge).toEqual(new TextEncoder().encode("challenge"))
    expect(depositProof?.signature).toBeDefined()
  })
})
