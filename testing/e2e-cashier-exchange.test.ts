import { describe, it, expect } from "bun:test"
import { create, toBinary, type DescMessage, type MessageShape } from "../applications/cashier/node_modules/@bufbuild/protobuf"
import { createConnectTransport } from "../applications/cashier/node_modules/@connectrpc/connect-web"
import { createClient } from "../applications/cashier/node_modules/@connectrpc/connect"
import { fromBinary as accountFromBinary, fromBinary as exchangeFromBinary } from "../applications/cashier/node_modules/@bufbuild/protobuf"
import { GetBalanceRequestSchema, GetBalanceResponseSchema } from "../applications/cashier/src/proto/gen/es/account/v1/account_pb.js"
import {
  BuyTokenRequestSchema,
  BuyTokenResponseSchema,
} from "../applications/cashier/src/proto/gen/es/exchange/v1/exchange_pb.js"
import { ExchangeService } from "../applications/cashier/src/proto/gen/es/exchange/v1/exchange_pb.js"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"
import { p256 } from "../applications/cashier/node_modules/@noble/curves/nist.js"

const ENVOY_HOST = process.env.EXCHANGE_ENVOY_HOST ?? "account.cashier-chart-test-exchange-envoy:8080"
const EXCHANGE_URL = process.env.EXCHANGE_ENVOY_URL ?? `http://${ENVOY_HOST}`
const OUTPROXY_URL = process.env.EXCHANGE_OUTPROXY_URL ?? "http://127.0.0.1:19091"
const AMOUNT = 1_000_000n
const DPOP_MASTER_SECRET = process.env.EXCHANGE_DPOP_MASTER_SECRET ?? "cashier-chart-test-exchange"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function base64Url(input: Uint8Array): string {
  return input.toBase64({ alphabet: "base64url", omitPadding: true })
}

function sha256Bytes(...inputs: Uint8Array[]): Uint8Array {
  const hash = new Bun.CryptoHasher("sha256")
  for (const input of inputs) hash.update(input)
  return new Uint8Array(hash.digest())
}

function computePrincipal(publicKeyBytes: Uint8Array): string {
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 4) throw new Error("invalid P-256 public key")
  const publicJwk = {
    crv: "P-256",
    kty: "EC",
    x: base64Url(publicKeyBytes.slice(1, 33)),
    y: base64Url(publicKeyBytes.slice(33)),
  }
  const digest = sha256Bytes(new TextEncoder().encode(JSON.stringify(publicJwk)))
  return CID.create(1, 0x55, createDigest(0x12, digest)).toString()
}

async function call(url: string | URL, request: Uint8Array | Uint8Array<ArrayBuffer>) {
  const path = typeof url === "string" && !url.includes("://") ? url : new URL(url).pathname
  const payload = request
  const response = await fetch(`http://${ENVOY_HOST}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "x-request-id": "cashier-exchange-chart-test",
      "Connect-Protocol-Version": "1",
    },
    body: payload,
    proxy: OUTPROXY_URL,
  } as any)
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`)
  return response
}

async function seedAccount(principal: string) {
  const insert = [
    "kubectl", "exec", "-n", "cashier-chart-test-exchange",
    "statefulset/exchange-postgres", "--", "psql", "-U", "postgres", "-d", "paid", "-v", "ON_ERROR_STOP=1", "-c",
    `INSERT INTO accounts (principal, balance, create_time, expire_time, privilege) VALUES ('${principal}', ${AMOUNT}, now(), now() + interval '1 day', 'user') ON CONFLICT (principal) DO UPDATE SET balance = ${AMOUNT}, expire_time = now() + interval '1 day'; INSERT INTO accounts (principal, balance, create_time, expire_time, privilege) VALUES ('bafk9pipdnq2i2cm3okcnonbmclhzt4fh40mk7oenuqxjj79rietgh8arse', 0, now(), now() + interval '1 day', 'user') ON CONFLICT (principal) DO UPDATE SET expire_time = now() + interval '1 day'`,
  ]
  const result = Bun.spawnSync(insert)
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

describe("Feature 5: production exchange chart", () => {
  let principal: string

  it("seeds the PostgreSQL account fixture", async () => {
    console.log("exchange test env", { ENVOY_HOST, EXCHANGE_URL, OUTPROXY_URL })
    const seed = sha256Bytes(new TextEncoder().encode("direct"), new TextEncoder().encode(DPOP_MASTER_SECRET))
    principal = computePrincipal(p256.getPublicKey(seed, false))
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await fetch(`${EXCHANGE_URL}/exchange.v1.ExchangeService/Ping`, { method: "POST" }); break } catch { await sleep(1000) }
    }
    await seedAccount(principal)
  }, 90_000)

  it("returns the seeded account balance through direct-mode outproxy", async () => {
    const request = toBinary(GetBalanceRequestSchema, {})
    const response = await call("/account.v1.AccountService/GetBalance", request)
    const result = accountFromBinary(GetBalanceResponseSchema, new Uint8Array(await response.arrayBuffer()))
    expect(result.balance).toBe(AMOUNT)
  })

  it("exchanges a seeded balance for a usage token", async () => {
    const request = create(BuyTokenRequestSchema, {
      audience: "bafk9pipdnq2i2cm3okcnonbmclhzt4fh40mk7oenuqxjj79rietgh8arse",
      amount: 10n,
    })
    const transport = createConnectTransport({
      baseUrl: `http://${ENVOY_HOST}`,
      useBinaryFormat: true,
      interceptors: [
        (next) => async (request) => {
          if (request.stream) throw new Error("streaming not supported")
          const bytes = toBinary(request.method.input, request.message)
          const response = await call(`${request.url}`, bytes)
          return {
            stream: false,
            service: request.service,
            method: request.method,
            header: response.headers,
            trailer: new Headers(),
            message: exchangeFromBinary(request.method.output, new Uint8Array(await response.arrayBuffer())),
          }
        },
      ],
    })
    const exchange = createClient(ExchangeService, transport)
    const result = await exchange.buyToken(request)
    expect(result.token.split(".")).toHaveLength(3)
  })
})
