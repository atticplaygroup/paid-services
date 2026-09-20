import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { fromBinary as accountFromBinary, toBinary } from "../applications/cashier/node_modules/@bufbuild/protobuf/dist/commonjs/index.js"
import { GetBalanceRequestSchema, GetBalanceResponseSchema } from "../applications/cashier/src/proto/gen/es/account/v1/account_pb.js"
import { Codec, CreateCASValueRequestSchema, CreateCASValueResponseSchema, GetCASValueRequestSchema, GetCASValueResponseSchema, StorageBackend } from "../applications/cashier/src/proto/gen/es/kvstore/v1/kvstore_pb.js"
import { create } from "../applications/cashier/node_modules/@bufbuild/protobuf/dist/commonjs/index.js"
import { CID } from "multiformats/cid"
import { create as createDigest } from "multiformats/hashes/digest"
import { sha256 } from "multiformats/hashes/sha2"
import { p256 } from "@noble/curves/nist.js"


const ENVOY_HOST = process.env.KVSTORE_ENVOY_HOST ?? "account.cashier-chart-test-kvstore-envoy:8080"
const KVSTORE_URL = process.env.KVSTORE_ENVOY_URL ?? `http://${ENVOY_HOST}`
const OUTPROXY_URL = process.env.KVSTORE_OUTPROXY_URL ?? "http://outproxy.cashier-chart-test-kvstore.svc.cluster.local:9090"
const PROXY_URL = process.env.KVSTORE_PROXY_URL ?? "http://127.0.0.1:19090"
const AMOUNT = 1_000_000n
const DPOP_MASTER_SECRET = process.env.KVSTORE_DPOP_MASTER_SECRET ?? "cashier-chart-test-kvstore"

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

async function seedBalance(principal: string) {
  const key = `u:${principal}`
  const set = Bun.spawnSync([
    "kubectl", "exec", "-n", "cashier-chart-test-kvstore", "deploy/kvstore-redis",
    "--", "redis-cli", "SET", key, AMOUNT.toString(),
  ])
  expect(set.exitCode).toBe(0)
  return principal
}

async function callAccountBinary(path: string, request: Uint8Array) {
  const command = Bun.spawnSync([
    "curl", "-sS", "-i", "--max-time", "30", "-x", PROXY_URL,
    `http://${ENVOY_HOST}${path}`, "-X", "POST",
    "-H", "Content-Type: application/proto",
    "-H", "x-request-id: cashier-kvstore-chart-test",
    "-H", "Connect-Protocol-Version: 1", "--data-binary", "@-",
  ], { stdin: Buffer.from(request), stdout: "pipe", stderr: "pipe" })
  const raw = command.stdout as Buffer
  const split = raw.indexOf("\r\n\r\n")
  if (command.exitCode !== 0) throw new Error(`curl failed: ${command.stderr.toString()}`)
  const statusText = raw.slice(0, raw.indexOf("\r\n")).toString()
  const status = Number(statusText.split(" ")[1])
  const response = new Response(raw.slice(split + 4), { status })
  if (!response.ok) throw new Error(`${path} failed: ${status} ${await response.text()}`)
  return response
}

describe("Feature 5: production kvstore chart", () => {
  let principal: string
  let portForward: ReturnType<typeof Bun.spawn> | undefined

  beforeAll(async () => {
    portForward = Bun.spawn([
      "kubectl", "-n", "cashier-chart-test-kvstore", "port-forward",
      "--address", "127.0.0.1", "svc/outproxy", "19090:9090",
    ], { stdout: "pipe", stderr: "pipe" })
    await sleep(2000)
  })

  afterAll(() => {
    portForward?.kill()
  })

  it("seeds a positive-balance account fixture", async () => {
    const seed = sha256Bytes(new TextEncoder().encode("direct"), new TextEncoder().encode(DPOP_MASTER_SECRET))
    const publicKeyBytes = p256.getPublicKey(seed, false)
    console.log("kvstore test env", { ENVOY_HOST, KVSTORE_URL, OUTPROXY_URL })
    for (let attempt = 0; attempt < 60; attempt++) {
      const readiness = Bun.spawnSync([
        "kubectl", "-n", "cashier-chart-test-kvstore", "get", "pod",
        "-l", "app=cashier-chart-test-kvstore-envoy",
        "-o", "jsonpath={.items[0].status.containerStatuses[0].ready}",
      ])
      if (readiness.stdout.toString().trim() === "true") break
      await sleep(1000)
    }
    principal = await seedBalance(computePrincipal(publicKeyBytes))
  }, 90_000)

  it("returns the seeded account balance through direct-mode outproxy", async () => {
    const request = toBinary(GetBalanceRequestSchema, {})
    const response = await callAccountBinary("/account.v1.AccountService/GetBalance", request)
    const result = accountFromBinary(GetBalanceResponseSchema, new Uint8Array(await response.arrayBuffer()))
    expect(result.balance).toBe(AMOUNT)
  })

  it("stores and retrieves a value through direct-mode outproxy", async () => {
    const value = new TextEncoder().encode("feature 5 kvstore chart")
    const key = (await CID.create(1, 0x55, await sha256.digest(value))).toString()
    const createdRequest = toBinary(CreateCASValueRequestSchema, create(CreateCASValueRequestSchema, {
      storageBackend: StorageBackend.BLOB_STORAGE,
      codec: Codec.RAW,
      key,
      value,
      ttl: { seconds: 600n },
    }))
    const created = await callAccountBinary("/kvstore.v1.MeteredStorageService/CreateCASValue", createdRequest)
    const createdResult = accountFromBinary(CreateCASValueResponseSchema, new Uint8Array(await created.arrayBuffer())) as { name?: string }
    expect(createdResult.name).toBeTruthy()
    console.log("CAS CIDs", { generated: key, returned: createdResult.name })
    const returnedKey = createdResult.name?.split("/").at(-1)
    expect(returnedKey).toBe(key)

    const retrievedRequest = toBinary(GetCASValueRequestSchema, create(GetCASValueRequestSchema, { key: returnedKey }))
    const retrieved = await callAccountBinary("/kvstore.v1.MeteredStorageService/GetCASValue", retrievedRequest)
    const retrievedResult = accountFromBinary(GetCASValueResponseSchema, new Uint8Array(await retrieved.arrayBuffer()))
    expect(new Uint8Array(Buffer.from(retrievedResult.value ?? "", "base64"))).toEqual(value)
  }, 60_000)
})
