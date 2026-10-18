import { describe, it, expect, beforeAll } from "bun:test"
import { generateKeyPair, generateProof } from "dpop"
import { createHash } from "crypto"
import { CID } from "multiformats/cid"
import { create } from "multiformats/hashes/digest"
import Redis from "ioredis"

async function computePrincipal(pubJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x, y: pubJwk.y })
  const hash = createHash("sha256").update(canonical).digest()
  const mhDigest = create(0x12, new Uint8Array(hash))
  return CID.create(1, 0xeb51, mhDigest).toString()
}

async function loadKeypairFromPath(path: string): Promise<CryptoKeyPair> {
  if (!await Bun.file(path).exists()) throw new Error(`Missing DPoP key ${path}; run testing/oci/test.sh with its repository-owned test Job, or configure PUSHER_DPOP_KEY_PATH, PULLER_DPOP_KEY_PATH, and OCI_PROVIDER_DPOP_KEY_PATH`)
  const jwk = JSON.parse(await Bun.file(path).text()) as JsonWebKey
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
    crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
  ])
  return { privateKey, publicKey }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const PUSHER_OCI_URL = process.env.PUSHER_OCI_URL ?? "http://pusher-oci.pusher-ns.svc.cluster.local:3000"
const STORAGE_PROVIDER_ENVOY_URL = process.env.STORAGE_PROVIDER_ENVOY_URL ?? "http://storage-provider-envoy.storage-provider-ns.svc.cluster.local:8080"
const OCI_PROVIDER_ENVOY_URL = process.env.OCI_PROVIDER_ENVOY_URL ?? "http://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8080"
const PULLER_OUTPROXY_URL = process.env.PULLER_OUTPROXY_URL ?? "http://puller-outproxy.puller-ns.svc.cluster.local:9090"
const OCI_PROVIDER_REDIS_URL = process.env.OCI_PROVIDER_REDIS_URL ?? "redis://oci-provider-redis.oci-provider-ns.svc.cluster.local:6379"
const STORAGE_PROVIDER_REDIS_URL = process.env.STORAGE_PROVIDER_REDIS_URL ?? "redis://storage-provider-redis.storage-provider-ns.svc.cluster.local:6379"

describe("e2e-kind: Pusher pushes image directly to storage provider", () => {
  let pusherKeypair: CryptoKeyPair
  let pusherPrincipal: string
  let pullerKeypair: CryptoKeyPair
  let pullerPrincipal: string
  let ociProviderKeypair: CryptoKeyPair
  let ociProviderPrincipal: string
  let blobDigest: string
  let blobContent: Uint8Array
  let repoName: string

  beforeAll(async () => {
    // Load Pusher's keypair
    const pusherKeyPath = process.env.PUSHER_DPOP_KEY_PATH ?? `/etc/dpop-keys/pusher.json`
    pusherKeypair = await loadKeypairFromPath(pusherKeyPath)
    const pusherPubJwk = await crypto.subtle.exportKey("jwk", pusherKeypair.publicKey)
    pusherPrincipal = await computePrincipal(pusherPubJwk)
    repoName = `${pusherPrincipal}/test`
    console.log("Pusher principal:", pusherPrincipal)
    console.log("Repo name:", repoName)

    // Load Puller's keypair
    const pullerKeyPath = process.env.PULLER_DPOP_KEY_PATH ?? `/etc/dpop-keys/puller.json`
    pullerKeypair = await loadKeypairFromPath(pullerKeyPath)
    const pullerPubJwk = await crypto.subtle.exportKey("jwk", pullerKeypair.publicKey)
    pullerPrincipal = await computePrincipal(pullerPubJwk)
    console.log("Puller principal:", pullerPrincipal)

    // Load OCI provider's keypair
    const ociProviderKeyPath = process.env.OCI_PROVIDER_DPOP_KEY_PATH ?? `/etc/dpop-keys/oci-provider.json`
    ociProviderKeypair = await loadKeypairFromPath(ociProviderKeyPath)
    const ociProviderPubJwk = await crypto.subtle.exportKey("jwk", ociProviderKeypair.publicKey)
    ociProviderPrincipal = await computePrincipal(ociProviderPubJwk)
    console.log("OCI provider principal:", ociProviderPrincipal)
    expect(ociProviderPrincipal).not.toBe(pusherPrincipal)

    // Faucet Pusher's account on storage provider
    const faucetStorageUrl = `${STORAGE_PROVIDER_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetStorageProof = await generateProof(pusherKeypair, faucetStorageUrl, "POST")
    const faucetStorageRes = await fetch(faucetStorageUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetStorageProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1_000_000_000 }),
    })
    expect(faucetStorageRes.status).toBe(200)
    console.log("Pusher fauceted on storage provider")

    // Faucet OCI provider's account on storage provider
    const faucetOciProviderStorageUrl = `${STORAGE_PROVIDER_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetOciProviderStorageProof = await generateProof(ociProviderKeypair, faucetOciProviderStorageUrl, "POST")
    const faucetOciProviderStorageRes = await fetch(faucetOciProviderStorageUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetOciProviderStorageProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1_000_000_000 }),
    })
    expect(faucetOciProviderStorageRes.status).toBe(200)
    console.log("OCI provider fauceted on storage provider")

    // Faucet Puller's account on OCI provider
    const faucetOciProviderUrl = `${OCI_PROVIDER_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetOciProviderProof = await generateProof(pullerKeypair, faucetOciProviderUrl, "POST")
    const faucetOciProviderRes = await fetch(faucetOciProviderUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetOciProviderProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1_000_000_000 }),
    })
    expect(faucetOciProviderRes.status).toBe(200)
    console.log("Puller fauceted on OCI provider")

    // Wait for Pusher's OCI
    console.log("Waiting for Pusher's OCI...")
    for (let i = 0; i < 60; i++) {
      try { await fetch(`${PUSHER_OCI_URL}/v2/`); break } catch {}
      await sleep(1000)
    }
    console.log("Pusher's OCI ready")
  })

  it("Pusher pushes blob and manifest to storage provider", async () => {
    // Create blob content
    blobContent = new Uint8Array(256)
    for (let i = 0; i < 256; i++) blobContent[i] = i
    blobDigest = `sha256:${createHash("sha256").update(Buffer.from(blobContent)).digest("hex")}`

    // Push blob through Pusher's OCI -> pusher-outproxy -> storage-provider-envoy -> storage-provider-kvstore
    const initRes = await fetch(`${PUSHER_OCI_URL}/v2/${repoName}/blobs/uploads/`, {
      method: "POST",
      headers: { "x-user-id": pusherPrincipal, "x-request-id": `${repoName}:upload-init` },
    })
    expect(initRes.status).toBe(202)
    const location = initRes.headers.get("Location")
    expect(location).toBeTruthy()
    const uploadUrl = new URL(location!, PUSHER_OCI_URL)
    uploadUrl.searchParams.set("digest", blobDigest)
    const putRes = await fetch(uploadUrl.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "x-user-id": pusherPrincipal, "x-request-id": `${repoName}:blob` },
      body: blobContent,
    })
    expect(putRes.status).toBe(201)
    console.log("Blob uploaded, digest:", blobDigest)

    // Push manifest
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: blobDigest, size: 256 },
      layers: [{ mediaType: "application/octet-stream", digest: blobDigest, size: 256 }],
    }
    const manifestRes = await fetch(`${PUSHER_OCI_URL}/v2/${repoName}/manifests/latest`, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json", "x-user-id": pusherPrincipal, "x-request-id": `${repoName}:manifest` },
      body: JSON.stringify(manifest),
    })
    expect(manifestRes.status).toBe(201)
    console.log("Manifest pushed")

    // Verify blob accessible
    await sleep(2000)
    const getBlobRes = await fetch(`${PUSHER_OCI_URL}/v2/${repoName}/blobs/${blobDigest}`, { headers: { "x-user-id": pusherPrincipal, "x-request-id": `${repoName}:blob-verify` } })
    expect(getBlobRes.status).toBe(200)
    const pulledBlob = new Uint8Array(await getBlobRes.arrayBuffer())
    expect(pulledBlob.length).toBe(256)
    expect(pulledBlob).toEqual(blobContent!)
    console.log("Pusher push verified")
  }, 60_000)

  it("Puller pulls image through OCI provider via puller-outproxy", async () => {
    // Puller pulls through puller-outproxy -> oci-provider-envoy -> oci-provider-oci -> oci-provider-outproxy -> storage-provider-envoy -> storage-provider-kvstore
    // puller-outproxy handles DPoP auth with Puller's keypair
    // Use in-cluster DNS for OCI_PROVIDER_ENVOY_URL because puller-outproxy (inside cluster) will forward to it
    const blobRes = await fetch(
      `https://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8443/v2/${repoName}/blobs/${blobDigest}`,
      {
        method: "GET",
        // @ts-ignore - Bun's native proxy option
        proxy: PULLER_OUTPROXY_URL,
      },
    )
    console.log("Puller pull blob status:", blobRes.status)
    if (blobRes.status !== 200) console.log("Body:", await blobRes.text())
    expect(blobRes.status).toBe(200)
    const pulledBlob = new Uint8Array(await blobRes.arrayBuffer())
    expect(pulledBlob.length).toBe(256)
    expect(pulledBlob).toEqual(blobContent!)
    console.log("Puller: blob pulled and verified")

    const manifestRes = await fetch(
      `https://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8443/v2/${repoName}/manifests/latest`,
      {
        method: "GET",
        // @ts-ignore - Bun's native proxy option
        proxy: PULLER_OUTPROXY_URL,
      },
    )
    console.log("Puller pull manifest status:", manifestRes.status)
    if (manifestRes.status !== 200) console.log("Body:", await manifestRes.text())
    expect(manifestRes.status).toBe(200)
    const pulledManifest = await manifestRes.json()
    expect(pulledManifest.schemaVersion).toBe(2)
    console.log("Puller: manifest pulled and verified")
  }, 60_000)

  it("Puller pull deduction changes when OCI provider unit prices change", async () => {
    const faucetOciProviderUrl = `${OCI_PROVIDER_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetOciProviderProof = await generateProof(pullerKeypair, faucetOciProviderUrl, "POST")
    const faucetOciProviderRes = await fetch(faucetOciProviderUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetOciProviderProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100_000_000_000 }),
    })
    expect(faucetOciProviderRes.status).toBe(200)

    // Deduction keys use the logged TLS SNI (empty in this scenario), listener port, and path.
    const priceKey = `p::8443:/v2/${repoName}/manifests/latest`

    const setPrice = async (field: string, value: string) => {
      const redis = new Redis(OCI_PROVIDER_REDIS_URL)
      try { await redis.hset(priceKey, field, value) } finally { redis.disconnect() }
    }
    const getBalance = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rpc = await fetch(`${OCI_PROVIDER_ENVOY_URL}/account.v1.AccountService/GetBalance`, {
            method: "POST",
            headers: { "x-user-id": pullerPrincipal, "Content-Type": "application/json" },
            body: JSON.stringify({ dummy: 1 }),
            proxy: PULLER_OUTPROXY_URL,
          } as any)
          if (rpc.ok) {
            const data = await rpc.json()
            return Number(data.balance ?? 0)
          }
        } catch {}
        await sleep(200)
      }
      throw new Error("GetBalance failed after retries")
    }
    const pull = async () => {
      const res = await fetch(
        `https://oci-provider-envoy.oci-provider-ns.svc.cluster.local:8443/v2/${repoName}/manifests/latest`,
        { method: "GET", proxy: PULLER_OUTPROXY_URL } as any,
      )
      if (res.status !== 200) {
        throw new Error(`pull failed: ${res.status} ${await res.text()}`)
      }
    }
    const waitForBalanceChange = async (initialBalance: number) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const balance = await getBalance()
        if (balance < initialBalance) return balance
        await sleep(200)
      }
      throw new Error("balance did not change after pull")
    }
    const waitForBalanceToSettle = async () => {
      let balance = await getBalance()
      let stableChecks = 0
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(1000)
        const nextBalance = await getBalance()
        if (nextBalance === balance) {
          stableChecks++
          if (stableChecks === 3) return nextBalance
        } else {
          stableChecks = 0
        }
        balance = nextBalance
      }
      throw new Error("balance did not settle")
    }

    await setPrice("METER_TYPE_DURATION_MS", "0")
    await setPrice("METER_TYPE_INGRESS_BYTES", "1")
    await setPrice("METER_TYPE_EGRESS_BYTES", "1")
    const balanceBeforeLow = await waitForBalanceToSettle()
    await pull()
    await waitForBalanceChange(balanceBeforeLow)
    const balanceAfterLow = await waitForBalanceToSettle()
    const lowDeduction = balanceBeforeLow - balanceAfterLow
    expect(lowDeduction).toBeGreaterThan(0)

    await setPrice("METER_TYPE_DURATION_MS", "0")
    await setPrice("METER_TYPE_INGRESS_BYTES", "10")
    await setPrice("METER_TYPE_EGRESS_BYTES", "10")
    const balanceBeforeHigh = await waitForBalanceToSettle()
    await pull()
    await waitForBalanceChange(balanceBeforeHigh)
    const balanceAfterHigh = await waitForBalanceToSettle()
    const highDeduction = balanceBeforeHigh - balanceAfterHigh
    expect(highDeduction).toBeGreaterThan(lowDeduction)
    expect(highDeduction).toBe(lowDeduction * 10)
    console.log("Puller pull deductions:", { lowDeduction, highDeduction })
  }, 60_000)

  it("Meter feedback works with deterministic external request ID", async () => {
    // Use a deterministic external request ID to test meter feedback
    const feedbackId = crypto.randomUUID()
    const feedbackRepo = `${pusherPrincipal}/feedback-test`
    const feedbackBlob = new Uint8Array(64)
    for (let i = 0; i < 64; i++) feedbackBlob[i] = i
    const feedbackBlobDigest = `sha256:${createHash("sha256").update(Buffer.from(feedbackBlob)).digest("hex")}`

    const feedbackPaths = [
      `/kvstore.v1.MeteredStorageService/CreateCASValue`,
    ]
    for (const path of feedbackPaths) {
      const priceKey = `p::8443:${path}`
      const redis = new Redis(STORAGE_PROVIDER_REDIS_URL)
      try {
        await redis.hset(priceKey, {
          METER_TYPE_DURATION_MS: "1",
          METER_TYPE_INGRESS_BYTES: "1",
          METER_TYPE_EGRESS_BYTES: "1",
        })
      } finally { redis.disconnect() }
    }

    // Push with deterministic external and metering request IDs.
    const initRes = await fetch(`${PUSHER_OCI_URL}/v2/${feedbackRepo}/blobs/uploads/`, {
      method: "POST",
      headers: {
        "x-user-id": pusherPrincipal,
        "x-request-id": feedbackId,
        "x-external-request-id": feedbackId,
      },
    })
    expect(initRes.status).toBe(202)
    const location = initRes.headers.get("Location")
    const uploadUrl = new URL(location!, PUSHER_OCI_URL)
    uploadUrl.searchParams.set("digest", feedbackBlobDigest)
    const putRes = await fetch(uploadUrl.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-user-id": pusherPrincipal,
        "x-request-id": feedbackId,
        "x-external-request-id": feedbackId,
      },
      body: feedbackBlob,
    })
    expect(putRes.status).toBe(201)
    console.log("Feedback blob uploaded with external request ID:", feedbackId)

    // Wait for Deduction to process meter feedback within its configured TTL
    await sleep(5000)

    // Query storage provider's GetMeterFeedback with the deterministic ID
    const feedbackUrl = `${STORAGE_PROVIDER_ENVOY_URL}/account.v1.AccountService/GetMeterFeedback`
    const feedbackProof = await generateProof(pusherKeypair, feedbackUrl, "POST")
    const feedbackRes = await fetch(feedbackUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${feedbackProof}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ external_request_id: feedbackId }),
    })
    expect(feedbackRes.status).toBe(200)
    const feedbackData = await feedbackRes.json()
    console.log("Meter feedback:", JSON.stringify(feedbackData))
    expect(feedbackData.feedback).toBeTruthy()
    expect(Number(feedbackData.feedback.totalPrice ?? 0)).toBeGreaterThan(0)
    expect(feedbackData.feedback.details).toBeTruthy()
    expect(Object.keys(feedbackData.feedback.details).length).toBeGreaterThanOrEqual(1)
    console.log("Meter feedback verified with deterministic ID:", feedbackId)
  }, 60_000)
})
