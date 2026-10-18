import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { fromBinary as accountFromBinary, toBinary } from "../../applications/cashier/node_modules/@bufbuild/protobuf"
import { GetBalanceRequestSchema, GetBalanceResponseSchema } from "../../applications/cashier/src/proto/gen/es/account/v1/account_pb.js"
import { Codec, CreateCASValueRequestSchema, CreateCASValueResponseSchema, GetCASValueRequestSchema, GetCASValueResponseSchema, StorageBackend } from "../../applications/cashier/src/proto/gen/es/kvstore/v1/kvstore_pb.js"
import { create } from "../../applications/cashier/node_modules/@bufbuild/protobuf"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"

const EXCHANGE_HOST = process.env.E2E_EXCHANGE_HOST ?? "quickstart-exchange-exchange:8080"
const KVSTORE_ENVOY_HOST = process.env.E2E_KVSTORE_ENVOY_HOST ?? "quickstart-provider-envoy:8080"
const CASHIER_URL = process.env.E2E_CASHIER_URL ?? "http://127.0.0.1:19092"
const OUTPROXY_URL = process.env.E2E_OUTPROXY_URL ?? "http://127.0.0.1:19090"
const NAMESPACE = process.env.E2E_NAMESPACE ?? "quickstart"
const PROXY_SERVICE = process.env.E2E_PROXY_SERVICE ?? "quickstart-internal"
const USER_ID = process.env.E2E_USER_ID ?? "bahi5maysecsg4flhocr2ogq2kczariervnol4dfhnobodrzbs3ssvfod2qwo2"
const REQUEST_ID = crypto.randomUUID()

function proofJwk(proof: string) {
  return JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString()).jwk
}

async function principalFromProof(proof: string) {
  const { crv, kty, x, y } = proofJwk(proof)
  const thumbprint = await sha256.digest(new TextEncoder().encode(JSON.stringify({ crv, kty, x, y })))
  return CID.createV1(0xeb51, thumbprint).toString()
}

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
      "x-user-id": USER_ID,
      "x-request-id": requestId,
    },
  )
  const result = await response.json() as { accessToken?: string }
  expect(result.accessToken).toBeTruthy()
  return result.accessToken!
}

async function getBalance(port: number, accessProof: string) {
  // Query the funded identity directly: cashier-mode outproxy replaces proofs.
  const principal = await principalFromProof(accessProof)
  const request = toBinary(GetBalanceRequestSchema, create(GetBalanceRequestSchema, {}))
  const response = await fetch(`http://127.0.0.1:${port}/account.v1.AccountService/GetBalance`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      Authorization: `Bearer ${accessProof}`,
      "x-user-id": principal,
      "x-request-id": crypto.randomUUID(),
      "Connect-Protocol-Version": "1",
    },
    body: request,
  })
  if (!response.ok) throw new Error(`GetBalance failed: ${response.status} ${await response.text()}`)
  const result = accountFromBinary(GetBalanceResponseSchema, new Uint8Array(await response.arrayBuffer()))
  return result.balance
}

describe("Feature 5: full cashier e2e", () => {
  let portForward: ReturnType<typeof Bun.spawn> | undefined
  const balanceForwards: ReturnType<typeof Bun.spawn>[] = []
  let cashierForward: ReturnType<typeof Bun.spawn> | undefined
  let providerProof: string
  let exchangeProof: string

  beforeAll(async () => {
    portForward = Bun.spawn([
      "kubectl", "-n", NAMESPACE, "port-forward", "--address", "127.0.0.1",
      `svc/${PROXY_SERVICE}`, "19090:9090",
    ], { stdout: "pipe", stderr: "pipe" })
    cashierForward = Bun.spawn([
      "kubectl", "-n", NAMESPACE, "port-forward", "--address", "127.0.0.1",
      `svc/${PROXY_SERVICE}`, "19092:8081",
    ], { stdout: "pipe", stderr: "pipe" })
    for (const service of ["quickstart-exchange-meter-account", "quickstart-provider-meter-account"]) {
      balanceForwards.push(Bun.spawn(["kubectl", "-n", NAMESPACE, "port-forward", "--address", "127.0.0.1", `svc/${service}`, `${19093 + balanceForwards.length}:8080`], { stdout: "pipe", stderr: "pipe" }))
    }
    for (const [forward, port] of [[portForward, 19090], [cashierForward, 19092], [balanceForwards[0], 19093], [balanceForwards[1], 19094]] as const) {
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (forward.exitCode !== null) throw new Error(`Port-forward failed: ${await new Response(forward.stderr).text()}`)
        try {
          const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open(socket) { socket.end() } } })
          socket.end()
          ready = true
          break
        } catch { await sleep(100) }
      }
      if (!ready) throw new Error(`Port-forward on ${port} did not become ready`)
    }
  }, 30_000)

  afterAll(() => {
    portForward?.kill()
    cashierForward?.kill()
    balanceForwards.forEach((forward) => forward.kill())
  })

  it("inspects the configured devnet wallet through cashier", async () => {
    const response = await callCashier("/cashier.v1.CashierService/GetChainBalance", {
      preferredPaymentCoin: 1,
      preferredPaymentEnvironment: 2,
    }, { "x-user-id": USER_ID, "x-request-id": crypto.randomUUID() })
    const wallet = await response.json() as { address: string; balance: string }
    expect(wallet.address).toMatch(/^0x[0-9a-f]{64}$/)
    expect(wallet.balance).toMatch(/^\d+$/)
    expect(BigInt(wallet.balance)).toBeGreaterThanOrEqual(0n)
  }, 60_000)

  it("funds the single default account from the SUI devnet faucet", async () => {
    await callCashier("/cashier.v1.CashierService/GetFunds", {
      preferredPaymentCoin: 1,
      preferredPaymentEnvironment: 2,
    }, {
      "x-user-id": USER_ID,
      "x-request-id": crypto.randomUUID(),
    })
  }, 300_000)

  it("funds a kvstore account through cashier", async () => {
    providerProof = await getAccessToken(
      `http://${KVSTORE_ENVOY_HOST}/kvstore.v1.MeteredStorageService/GetCASValue`,
      "POST",
      REQUEST_ID,
    )
    expect(providerProof.split(".")).toHaveLength(3)
  }, 300_000)

  it("has the remaining exchange balance after lazy provider deposit", async () => {
    const proof = await getAccessToken(
      `http://${EXCHANGE_HOST}/account.v1.AccountService/GetBalance`,
      "POST",
      crypto.randomUUID(),
    )
    const balance = await getBalance(19093, proof)
    expect(balance).toBe(99_900_000n)
  }, 60_000)

  it("has the default kvstore balance after usage-token deposit", async () => {
    const proof = await getAccessToken(
      `http://${KVSTORE_ENVOY_HOST}/account.v1.AccountService/GetBalance`,
      "POST",
      crypto.randomUUID(),
    )
    const balance = await getBalance(19094, proof)
    expect(balance).toBe(100_000n)
  }, 60_000)

  it("uses a different DPoP JKT for exchange", async () => {
    exchangeProof = await getAccessToken(
      `http://${EXCHANGE_HOST}/exchange.v1.ExchangeService/Ping`,
      "POST",
      crypto.randomUUID(),
    )
    const exchangeJwk = proofJwk(exchangeProof)
    const providerJwk = proofJwk(providerProof)
    expect(exchangeJwk).toMatchObject({ kty: "EC", crv: "P-256" })
    expect(providerJwk).toMatchObject({ kty: "EC", crv: "P-256" })
    expect(await principalFromProof(exchangeProof)).not.toBe(await principalFromProof(providerProof))
  }, 60_000)

  it("stores and retrieves a value through outproxy", async () => {
    const value = new TextEncoder().encode("feature 5 full e2e")
    const key = CID.createV1(0x55, await sha256.digest(value)).toString()
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
        "x-user-id": USER_ID,
        "x-request-id": REQUEST_ID,
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
        "x-request-id": REQUEST_ID,
        "x-user-id": USER_ID,
        "Connect-Protocol-Version": "1",
      },
      body: retrievedRequest,
      proxy: OUTPROXY_URL,
    } as any)
    if (!retrieved.ok) throw new Error(`GetCASValue failed: ${retrieved.status} ${await retrieved.text()}`)
    const retrievedResult = accountFromBinary(GetCASValueResponseSchema, new Uint8Array(await retrieved.arrayBuffer()))
    expect(retrievedResult.value).toEqual(value)
  }, 60_000)
})
