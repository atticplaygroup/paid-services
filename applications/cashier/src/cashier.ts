import { create } from "@bufbuild/protobuf"
import { createClient } from "@connectrpc/connect"
import { createConnectTransport } from "@connectrpc/connect-web"
import { fromJson } from "@bufbuild/protobuf"
import * as dpop from "dpop"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { Transaction } from "@mysten/sui/transactions"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import type { CashierConfig, PaymentConfig } from "./config.js"
import { base64UrlDecode, dpopSeed, importDpopSeed, normalizeHtu, providerId, sha256, thumbprintFromJwk } from "./identity.js"
import {
  AccountService,
  GetBalanceRequestSchema,
  DepositOrCreateAccountRequestSchema,
} from "./proto/gen/es/account/v1/account_pb.js"
import {
  BuyTokenRequestSchema,
  DepositRequestSchema,
  ExchangeService,
  GetChallengeRequestSchema,
  ListPaymentMethodsRequestSchema,
  PaymentCoin,
  PaymentCoinSchema,
  PaymentEnvironment,
  PaymentEnvironmentSchema,
} from "./proto/gen/es/exchange/v1/exchange_pb.js"
import {
  GetAccessTokenResponseSchema,
  ProviderManifest,
  GetFundsResponseSchema,
  ProviderManifestSchema,
} from "./proto/gen/es/cashier/v1/cashier_pb.js"

interface ManifestExchange {
  id: string
  hosts: string[]
  paymentCoin: PaymentCoin
  paymentEnvironment: PaymentEnvironment
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type SuiClientLike = {
  signAndExecuteTransaction(input: {
    transaction: Transaction
    signer: Ed25519Keypair
    options?: { showEffects?: boolean }
  }): Promise<{ digest: string }>
}

export interface CashierDeps {
  fetch?: FetchLike
  suiClientFactory?: (payment: PaymentConfig) => SuiClientLike
  faucetRequest?: (payment: PaymentConfig, recipient: string) => Promise<unknown>
  clock?: () => Date
}

export class FaucetNotImplementedError extends Error {}

export class Cashier implements CashierServiceImplementation {
  readonly #config: CashierConfig
  readonly #deps: Required<Pick<CashierDeps, "clock">> & CashierDeps
  readonly #keypairs = new Map<string, Promise<dpop.KeyPair>>()
  readonly #accountClients = new Map<string, ReturnType<typeof createClient<typeof AccountService>>>()
  readonly #exchangeClients = new Map<string, ReturnType<typeof createClient<typeof ExchangeService>>>()

  constructor(config: CashierConfig, deps: CashierDeps = {}) {
    this.#config = config
    this.#deps = { clock: deps.clock ?? (() => new Date()), ...deps }
  }

  #account(principal: string) {
    const account = this.#config.accounts.find((entry) => entry.principal === principal)
    if (!account) throw new Error("unknown principal")
    return account
  }

  #payment(account: { payments: PaymentConfig[] }, coin: PaymentCoin, environment: PaymentEnvironment) {
    return account.payments.find((payment) => payment.paymentCoin === coin && payment.paymentEnvironment === environment)
  }

  #keypair(account: { masterSecret: Uint8Array }, hostname: string): Promise<dpop.KeyPair> {
    const cacheKey = `${Buffer.from(account.masterSecret).toString("hex")}:${hostname}`
    let promise = this.#keypairs.get(cacheKey)
    if (!promise) {
      const seed = dpopSeed(this.#config.accountSalt, account.masterSecret, hostname)
      promise = importDpopSeed(seed)
      this.#keypairs.set(cacheKey, promise)
    }
    return promise
  }

  async #principal(keypair: dpop.KeyPair): Promise<string> {
    const jwk = await crypto.subtle.exportKey("jwk", keypair.publicKey)
    return providerId(thumbprintFromJwk({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
  }

  async #accountBalance(hostname: string, account: { masterSecret: Uint8Array }, routeHtu: string): Promise<bigint> {
    const client = this.#accountClient(hostname)
    const keypair = await this.#keypair(account, hostname)
    const principal = await this.#principal(keypair)
    const proof = await dpop.generateProof(keypair, normalizeHtu(routeHtu), "POST")
    try {
      const response = await client.getBalance(create(GetBalanceRequestSchema, {}), {
        headers: {
          Authorization: `Bearer ${proof}`,
          "x-request-id": crypto.randomUUID(),
          "x-user-id": principal,
        },
      })
      console.log("account balance request succeeded", { hostname, routeHtu })
      return response.balance
    } catch (error) {
      console.log("account balance request failed", { hostname, routeHtu, error })
      if (error instanceof Error && (error.message.includes("account not found") || error.message.includes("balance not found"))) return 0n
      throw error
    }
  }

  async #providerManifest(hostname: string) {
    const scheme = this.#config.insecure ? "http" : "https"
    const manifestUrl = `${scheme}://${hostname}/.well-known/paid_provider_manifest.json`
    const response = await (this.#deps.fetch?.call(globalThis, manifestUrl) ?? globalThis.fetch(manifestUrl))
    if (!response.ok) throw new Error(`provider manifest fetch failed: ${response.status}`)
    return fromJson(ProviderManifestSchema, await response.json())
  }

  async #verifyManifest(hostname: string) {
    const raw = await this.#providerManifest(hostname)
    const [header, payload, signature] = raw.signature.split(".")
    if (!header || !payload || !signature) throw new Error("invalid provider manifest signature")
    const unsigned = fromJson(ProviderManifestSchema, { version: raw.version, id: raw.id, exchanges: raw.exchanges.map((exchange) => ({ id: exchange.id, hosts: exchange.hosts, payment_coin: this.enumName(PaymentCoinSchema, exchange.paymentCoin), payment_environment: this.enumName(PaymentEnvironmentSchema, exchange.paymentEnvironment) })) })
    const encodedHeader = JSON.parse(new TextDecoder().decode(base64UrlDecode(header))) as { jwk?: { x?: string; y?: string } }
    if (!encodedHeader.jwk?.x || !encodedHeader.jwk.y) throw new Error("provider manifest does not include issuer JWK")
    const publicJwk = { crv: "P-256", kty: "EC", x: encodedHeader.jwk.x, y: encodedHeader.jwk.y }
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"])
    const data = new TextEncoder().encode(`${header}.${payload}`)
    const signatureBytes = base64UrlDecode(signature)
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signatureBytes, data)
    if (!valid) throw new Error("provider manifest signature verification failed")
    const thumbprint = thumbprintFromJwk({ crv: "P-256", kty: "EC", x: encodedHeader.jwk.x, y: encodedHeader.jwk.y })
    if (raw.id !== providerId(thumbprint)) throw new Error("provider manifest id does not match signer identity")
    return { manifest: raw, exchanges: raw.exchanges }
  }

  enumName(schema: { values: readonly { name: string; number: number }[] }, value: number): string {
    return schema.values.find((entry) => entry.number === value)?.name ?? ""
  }

  #accountClient(hostname: string) {
    const key = `${AccountService.typeName}:${hostname}`
    let client = this.#accountClients.get(key)
    if (!client) {
      client = createClient(AccountService, createConnectTransport({
        baseUrl: this.#serviceOrigin(hostname),
        useBinaryFormat: true,
        maxAttempts: 5,
        fetch: this.#deps.fetch ? ((input, init) => this.#deps.fetch!(input as RequestInfo | URL, init)) : undefined,
      }))
      this.#accountClients.set(key, client)
    }
    return client
  }

  #exchangeClient(hostname: string) {
    const key = `${ExchangeService.typeName}:${hostname}`
    let client = this.#exchangeClients.get(key)
    if (!client) {
      client = createClient(ExchangeService, createConnectTransport({
        baseUrl: this.#exchangeServiceOrigin(hostname),
        useBinaryFormat: true,
        maxAttempts: 5,
        fetch: this.#deps.fetch ? ((input, init) => this.#deps.fetch!(input as RequestInfo | URL, init)) : undefined,
      }))
      this.#exchangeClients.set(key, client)
    }
    return client
  }

  #serviceOrigin(hostname: string): string {
    const scheme = this.#config.insecure ? "http" : "https"
    const overrides = this.#config.accountOriginOverrides ?? {}
    const fallbackHostname = hostname.includes(":") ? new URL(`http://${hostname}`).hostname : hostname
    const override = overrides[hostname] ?? overrides[fallbackHostname]
    if (typeof override === "string") return override
    return `${scheme}://account.${hostname}`
  }

  #exchangeServiceOrigin(hostname: string): string {
    const scheme = this.#config.insecure ? "http" : "https"
    const overrides = this.#config.exchangeOriginOverrides ?? {}
    const fallbackHostname = hostname.includes(":") ? new URL(`http://${hostname}`).hostname : hostname
    const override = overrides[hostname] ?? overrides[fallbackHostname]
    if (typeof override === "string") return override
    return `${scheme}://exchange.${hostname}`
  }

  #keyHostname(hostname: string): string {
    return hostname.includes(":") ? new URL(`http://${hostname}`).hostname : hostname
  }

  async getAccessToken(request: { htu: string; htm: string; preferredPaymentCoin: PaymentCoin; preferredPaymentEnvironment: PaymentEnvironment }, principal: string) {
    const account = this.#account(principal)
    const htu = new URL(request.htu)
    const manifestHostname = htu.host
    const hostname = this.#keyHostname(htu.host)
    const keypair = await this.#keypair(account, hostname)
    const providerBalanceHtu = `${this.#serviceOrigin(hostname)}/account.v1.AccountService/GetBalance`
    if (await this.#accountBalance(hostname, account, providerBalanceHtu) > 0n) {
      const proof = await dpop.generateProof(keypair, normalizeHtu(request.htu), request.htm)
      return create(GetAccessTokenResponseSchema, { accessToken: proof })
    }
    const verified = await this.#verifyManifest(manifestHostname)
    const exchange = this.#chooseExchange(verified.exchanges, request.preferredPaymentCoin, request.preferredPaymentEnvironment, account)
    const payment = exchange.payment
    const exchangeHostname = exchange.hostname
    const exchangeAccount = { masterSecret: account.masterSecret }
    const exchangeBalanceHtu = `${this.#serviceOrigin(exchangeHostname)}/account.v1.AccountService/GetBalance`
    if (await this.#accountBalance(exchangeHostname, exchangeAccount, exchangeBalanceHtu) > 0n) {
      await this.#buyAndDeposit(verified.manifest.id, hostname, exchangeHostname, exchangeAccount, payment)
    } else {
      await this.#depositToExchange(exchangeHostname, exchangeAccount, payment)
      await this.#buyAndDeposit(verified.manifest.id, hostname, exchangeHostname, exchangeAccount, payment)
    }
    const proof = await dpop.generateProof(keypair, normalizeHtu(request.htu), request.htm)
    return create(GetAccessTokenResponseSchema, { accessToken: proof })
  }

  #chooseExchange(exchanges: ProviderExchange[], preferredCoin: PaymentCoin, preferredEnvironment: PaymentEnvironment, account: { payments: PaymentConfig[] }) {
    const candidates = exchanges.flatMap((exchange) => {
      const hostname = exchange.hosts.map((host) => { try { return new URL(host).host } catch { return undefined } }).find(Boolean)
      if (!hostname) return []
      return account.payments.flatMap((payment) => {
        if (payment.paymentCoin !== exchange.paymentCoin || payment.paymentEnvironment !== exchange.paymentEnvironment) return []
        const exact = payment.paymentCoin === preferredCoin && payment.paymentEnvironment === preferredEnvironment
        return [{ exchange, hostname, payment, exact }]
      })
    })
    const selected = candidates.find((entry) => entry.exact) ?? candidates[0]
    if (!selected) throw new Error("no exchange supported by cashier")
    return { hostname: selected.hostname, payment: selected.payment, exchange: selected.exchange }
  }


  async #depositToExchange(hostname: string, account: { masterSecret: Uint8Array }, payment: PaymentConfig) {
    hostname = this.#keyHostname(hostname)
    const client = this.#exchangeClient(hostname)
    const methods = await client.listPaymentMethods(create(ListPaymentMethodsRequestSchema, {}), {
      headers: { "x-request-id": crypto.randomUUID(), "x-user-id": await this.#principal(await this.#keypair(account, hostname)) },
    })
    const method = methods.paymentMethods.find((entry) => entry.coin === payment.paymentCoin && entry.environment === payment.paymentEnvironment)
    if (!method?.address) throw new Error("exchange has no matching payment method")
    const keypair = Ed25519Keypair.deriveKeypair(payment.mnemonic)
    const suiClient = this.#deps.suiClientFactory?.(payment) ?? new SuiGrpcClient({ baseUrl: payment.suiRpcUrl ?? this.suiUrl(payment.paymentEnvironment), network: this.suiNetwork(payment.paymentEnvironment) })
    const transaction = new Transaction()
    transaction.setSenderIfNotSet(keypair.toSuiAddress())
    const [coin] = transaction.splitCoins(transaction.gas, [this.#config.defaultChainDepositAmount])
    transaction.transferObjects([coin], method.address)
    const result = await suiClient.signAndExecuteTransaction({
      transaction,
      signer: keypair,
      options: { showEffects: true },
    })
    const requestBody = JSON.stringify({
      query: `query { transaction(digest: "${result.Transaction.digest}") { effects { status } } }`,
    })
    let succeeded = false
    for (let attempt = 0; attempt < 20; attempt++) {
      const transactionResponse = await (this.#deps.fetch?.call(globalThis, "https://graphql.devnet.sui.io/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }) ?? globalThis.fetch("https://graphql.devnet.sui.io/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      }))
      if (!transactionResponse.ok) throw new Error(`SUI transaction status check failed: ${transactionResponse.status}`)
      const transactionStatus = await transactionResponse.json() as { data?: { transaction?: { effects?: { status?: string } } } }
      console.log("sui transaction status check", transactionStatus)
      if (transactionStatus.data?.transaction?.effects?.status === "SUCCESS") {
        succeeded = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!succeeded) throw new Error("SUI transaction did not succeed")
    const challenge = await client.getChallenge(create(GetChallengeRequestSchema, { address: keypair.toSuiAddress() }), {
      headers: { "x-request-id": crypto.randomUUID(), "x-user-id": await this.#principal(await this.#keypair(account, hostname)) },
    })
    const signed = await keypair.signPersonalMessage(challenge.challenge)
    await verifyPersonalMessageSignature(challenge.challenge, signed.signature, { address: keypair.toSuiAddress() })
    await client.deposit(create(DepositRequestSchema, {
      ttl: { seconds: BigInt(24 * 3600) },
      proof: {
        chainDigest: result.Transaction.digest,
        startTime: challenge.startTime,
        challenge: challenge.challenge,
        signature: signed.signature,
      },
    }), {
      headers: { "x-request-id": crypto.randomUUID(), "x-user-id": await this.#principal(await this.#keypair(account, hostname)) },
    })
  }

  async #buyAndDeposit(providerId: string, providerHostname: string, exchangeHostname: string, account: { masterSecret: Uint8Array }, payment: PaymentConfig) {
    providerHostname = this.#keyHostname(providerHostname)
    exchangeHostname = this.#keyHostname(exchangeHostname)
    const exchangeClient = this.#exchangeClient(exchangeHostname)
    const keypair = await this.#keypair(account, exchangeHostname)
    const exchangeBalanceHtu = `${this.#serviceOrigin(exchangeHostname)}/account.v1.AccountService/GetBalance`
    const exchangeHtu = normalizeHtu(`${this.#exchangeServiceOrigin(exchangeHostname)}/exchange.v1.ExchangeService/BuyToken`)
    const proof = await dpop.generateProof(keypair, exchangeHtu, "POST")
    const exchangeBalance = await this.#accountBalance(exchangeHostname, account, exchangeBalanceHtu)
    const amount = exchangeBalance < this.#config.defaultProviderDepositAmount ? exchangeBalance : this.#config.defaultProviderDepositAmount
    if (amount <= 0n) throw new Error("exchange balance is not positive")
    const tokenResponse = await exchangeClient.buyToken(create(BuyTokenRequestSchema, {
      audience: providerId,
      amount,
    }), {
      headers: {
        Authorization: `Bearer ${proof}`,
        "x-request-id": crypto.randomUUID(),
        "x-user-id": await this.#principal(await this.#keypair(account, exchangeHostname)),
      },
    })
    const providerClient = this.#accountClient(providerHostname)
    const providerKeypair = await this.#keypair(account, providerHostname)
    const providerProof = await dpop.generateProof(providerKeypair, normalizeHtu(`${this.#serviceOrigin(providerHostname)}/account.v1.AccountService/DepositOrCreateAccount`), "POST")
    await providerClient.depositOrCreateAccount(create(DepositOrCreateAccountRequestSchema, { jwt: tokenResponse.token }), {
      headers: {
        Authorization: `Bearer ${providerProof}`,
        "x-request-id": crypto.randomUUID(),
        "x-user-id": await this.#principal(await this.#keypair(account, providerHostname)),
      },
    })
  }

  suiNetwork(environment: PaymentEnvironment): "mainnet" | "testnet" | "devnet" | "localnet" {
    switch (environment) {
      case PaymentEnvironment.MAINNET: return "mainnet"
      case PaymentEnvironment.TESTNET: return "testnet"
      case PaymentEnvironment.DEVNET: return "devnet"
      case PaymentEnvironment.LOCALNET: return "localnet"
      default: throw new Error("unsupported SUI environment")
    }
  }

  suiFaucetUrl(payment: PaymentConfig): string {
    if (payment.suiFaucetUrl) return payment.suiFaucetUrl
    const environment = payment.paymentEnvironment
    switch (environment) {
      case PaymentEnvironment.MAINNET: throw new Error("faucet is unavailable for mainnet")
      case PaymentEnvironment.TESTNET: return "https://faucet.testnet.sui.io"
      case PaymentEnvironment.DEVNET: return "https://faucet.devnet.sui.io"
      case PaymentEnvironment.LOCALNET: return "http://127.0.0.1:9123"
      default: throw new Error("unsupported SUI environment")
    }
  }

  suiUrl(environment: PaymentEnvironment): string {
    switch (environment) {
      case PaymentEnvironment.MAINNET:
        return "https://fullnode.mainnet.sui.io"
      case PaymentEnvironment.TESTNET:
        return "https://fullnode.testnet.sui.io"
      case PaymentEnvironment.DEVNET:
        return "https://fullnode.devnet.sui.io:443"
      case PaymentEnvironment.LOCALNET:
        return "http://localhost:9000"
      default:
        throw new Error("unsupported SUI environment")
    }
  }

  async getFunds(request: { preferredPaymentCoin: PaymentCoin; preferredPaymentEnvironment: PaymentEnvironment }, principal: string) {
    const account = this.#account(principal)
    const payment = this.#payment(account, request.preferredPaymentCoin, request.preferredPaymentEnvironment)
    if (!payment) throw new Error("no matching payment configuration")
    if (payment.paymentEnvironment === PaymentEnvironment.MAINNET) {
      throw new FaucetNotImplementedError("faucet is not implemented for mainnet")
    }
    const keypair = Ed25519Keypair.deriveKeypair(payment.mnemonic)
    await (this.#deps.faucetRequest?.(payment, keypair.toSuiAddress()) ?? requestSuiFromFaucetV2({ host: this.suiFaucetUrl(payment), recipient: keypair.toSuiAddress() }))
    return create(GetFundsResponseSchema, {})
  }
}


type GetAccessTokenRequest = { htu: string; htm: string; preferredPaymentCoin: PaymentCoin; preferredPaymentEnvironment: PaymentEnvironment }
type ProviderExchange = ProviderManifest["exchanges"][number]
type GetFundsRequest = { preferredPaymentCoin: PaymentCoin; preferredPaymentEnvironment: PaymentEnvironment }

type CashierServiceImplementation = {
  getAccessToken(request: GetAccessTokenRequest, principal: string): ReturnType<Cashier["getAccessToken"]>
  getFunds(request: GetFundsRequest, principal: string): ReturnType<Cashier["getFunds"]>
}
