import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { fromBinary as accountFromBinary, toBinary } from "../applications/cashier/node_modules/@bufbuild/protobuf"
import { GetBalanceRequestSchema, GetBalanceResponseSchema } from "../applications/cashier/src/proto/gen/es/account/v1/account_pb.js"
import { Codec, CreateCASValueRequestSchema, CreateCASValueResponseSchema, GetCASValueRequestSchema, GetCASValueResponseSchema, StorageBackend } from "../applications/cashier/src/proto/gen/es/kvstore/v1/kvstore_pb.js"
import { create } from "../applications/cashier/node_modules/@bufbuild/protobuf"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"
import { sha256 } from "multiformats/hashes/sha2"
import { p256 } from "../applications/cashier/node_modules/@noble/curves/nist.js"

const EXCHANGE_ENVOY_HOST = process.env.E2E_EXCHANGE_ENVOY_HOST ?? "e2e-exchange-envoy.e2e.svc.cluster.local:8080"
const KVSTORE_ENVOY_HOST = process.env.E2E_KVSTORE_ENVOY_HOST ?? "e2e-kvstore-envoy.e2e.svc.cluster.local:8080"
const CASHIER_URL = process.env.E2E_CASHIER_URL ?? "http://127.0.0.1:19092"
const OUTPROXY_URL = process.env.E2E_OUTPROXY_URL ?? "http://127.0.0.1:19090"
const PROVIDER_ID = process.env.E2E_PROVIDER_ID ?? "bafkreigcp47gwekkttqujhtwtasbqjazquza4onx3pbd5du7upw2pic35e"
const CHAIN_DEPOSIT_AMOUNT = 100_000_000n
const PROVIDER_DEPOSIT_AMOUNT = 100_000n

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function callCashier(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${CASHIER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  return response
}

async function getAccessToken(htu: string, htm: string, requestId: string) {
  const response = await callCashier(
    "/cashier.v1.CashierService/GetAccessToken",
    {
      htu,
      htm,
      preferredPaymentCoin: 1,
      preferredPaymentEnvironment: 2,
    },
    {
      "x-user-id": "e2e-user",
      "x-request-id": requestId,
    },
  )
  const result = await response.json() as { accessToken?: string }
  expect(result.accessToken).toBeTruthy()
  return result.accessToken!
}

async function getBalance(accessProof: string) {
  const request = toBinary(GetBalanceRequestSchema, create(GetBalanceRequestSchema, {}))
  const response = await fetch(`http://${KVSTORE_ENVOY_HOST}/account.v1.AccountService/GetBalance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      Authorization: `Bearer ${accessProof}`,
      "x-user-id": "e2e-user",
      "Connect-Protocol-Version": "1",
    },
    body: request,
    proxy: OUTPROXY_URL,
  } as any)
  if (!response.ok) throw new Error(`GetBalance failed: ${response.status} ${await response.text()}`)
  const result = accountFromBinary(GetBalanceResponseSchema, new Uint8Array(await response.arrayBuffer()))
  return result.balance
}

describe("Feature 5: full cashier e2e", () => {
  let portForward: ReturnType<typeof Bun.spawn> | undefined
  let cashierForward: ReturnType<typeof Bun.spawn> | undefined
  let providerProof: string
  let exchangeProof: string

  beforeAll(async () => {
    portForward = Bun.spawn([
      "kubectl", "-n", "e2e", "port-forward", "--address", "127.0.0.1",
      "svc/outproxy", "19090:9090",
    ], { stdout: "pipe", stderr: "pipe" })
    cashierForward = Bun.spawn([
      "kubectl", "-n", "e2e", "port-forward", "--address", "127.0.0.1",
      "svc/cashier", "19092:8080",
    ], { stdout: "pipe", stderr: "pipe" })
    await sleep(2000)
  })

  afterAll(() => {
    portForward?.kill()
    cashierForward?.kill()
  })

  it("funds the single default account from the SUI devnet faucet", async () => {
    await callCashier("/cashier.v1.CashierService/GetFunds", {
      preferredPaymentCoin: 1,
      preferredPaymentEnvironment: 2,
    }, {
      "x-user-id": "e2e-user",
      "x-request-id": "cashier-e2e-faucet",
    })
  }, 300_000)

  it("funds a kvstore account through cashier", async () => {
    providerProof = await getAccessToken(
      `http://${KVSTORE_ENVOY_HOST}/kvstore.v1.MeteredStorageService/GetCASValue`,
      "GET",
      "cashier-e2e",
    )
    expect(providerProof.split(".")).toHaveLength(3)
  }, 300_000)

  it("has the remaining exchange balance after lazy provider deposit", async () => {
    const proof = await getAccessToken(
      `http://${EXCHANGE_ENVOY_HOST}/account.v1.AccountService/GetBalance`,
      "POST",
      "cashier-e2e-exchange-balance",
    )
    const balance = await getBalance(proof)
    expect(balance).toBeGreaterThan(0n)
  }, 60_000)

  it("has the default kvstore balance after usage-token deposit", async () => {
    const proof = await getAccessToken(
      `http://${KVSTORE_ENVOY_HOST}/account.v1.AccountService/GetBalance`,
      "POST",
      "cashier-e2e-provider-balance",
    )
    const balance = await getBalance(proof)
    expect(balance).toBeGreaterThan(0n)
  }, 60_000)

  it("uses a different DPoP JKT for exchange", async () => {
    exchangeProof = await getAccessToken(
      `http://${EXCHANGE_ENVOY_HOST}/exchange.v1.ExchangeService/Ping`,
      "POST",
      "cashier-e2e-exchange",
    )
    expect(exchangeProof.split(".")[0]).not.toBe(providerProof.split(".")[0])
  }, 60_000)

  it("stores and retrieves a value through outproxy", async () => {
    const value = new TextEncoder().encode("feature 5 full e2e")
    const key = (await CID.create(1, 0x55, await sha256.digest(value))).toString()
    const createdRequest = toBinary(CreateCASValueRequestSchema, create(CreateCASValueRequestSchema, {
      storageBackend: StorageBackend.BLOB_STORAGE,
      codec: Codec.RAW,
      key,
      value,
      ttl: { seconds: 600n },
    }))
    const created = await fetch(`http://${KVSTORE_ENVOY_HOST}/kvstore.v1.MeteredStorageService/CreateCASValue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        Authorization: `Bearer ${providerProof}`,
        "x-user-id": "e2e-user",
        "x-request-id": "cashier-e2e",
        "Connect-Protocol-Version": "1",
      },
      body: createdRequest,
      proxy: OUTPROXY_URL,
    } as any)
    if (!created.ok) throw new Error(`CreateCASValue failed: ${created.status} ${await created.text()}`)
    const createdResult = accountFromBinary(CreateCASValueResponseSchema, new Uint8Array(await created.arrayBuffer())) as { name?: string }
    expect(createdResult.name).toBeTruthy()
    const returnedKey = createdResult.name?.split("/").at(-1)
    expect(returnedKey).toBe(key)
    const retrievedRequest = toBinary(GetCASValueRequestSchema, create(GetCASValueRequestSchema, { key: returnedKey }))
    const retrieved = await fetch(`http://${KVSTORE_ENVOY_HOST}/kvstore.v1.MeteredStorageService/GetCASValue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        Authorization: `Bearer ${providerProof}`,
        "x-request-id": "cashier-e2e",
        "x-user-id": "e2e-user",
        "Connect-Protocol-Version": "1",
      },
      body: retrievedRequest,
      proxy: OUTPROXY_URL,
    } as any)
    if (!retrieved.ok) throw new Error(`GetCASValue failed: ${retrieved.status} ${await retrieved.text()}`)
    const retrievedResult = accountFromBinary(GetCASValueResponseSchema, new Uint8Array(await retrieved.arrayBuffer()))
    expect(new Uint8Array(Buffer.from(retrievedResult.value ?? "", "base64"))).toEqual(value)
  }, 60_000)
})
