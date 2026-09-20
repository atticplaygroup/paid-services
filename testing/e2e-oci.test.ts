import { describe, it, expect, beforeAll } from "bun:test"
import { generateKeyPair, generateProof } from "dpop"
import { createHash } from "crypto"
import { CID } from "multiformats/cid"
import { create } from "multiformats/hashes/digest"

async function computePrincipal(pubJwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: pubJwk.crv, kty: pubJwk.kty, x: pubJwk.x, y: pubJwk.y })
  const hash = createHash("sha256").update(canonical).digest()
  const mhDigest = create(0x12, new Uint8Array(hash))
  return CID.create(1, 0x55, mhDigest).toString()
}

async function loadKeypairFromPath(path: string): Promise<CryptoKeyPair> {
  const jwk = JSON.parse(await Bun.file(path).text()) as JsonWebKey
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
    crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
  ])
  return { privateKey, publicKey }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

process.env.KUBECONFIG ||= "/home/user/paids-test/.kubeconfig"

const CHARLIE_OCI_URL = process.env.CHARLIE_OCI_URL ?? "http://oci-charlie.charlie-ns.svc.cluster.local:3000"
const S_ENVOY_URL = process.env.S_ENVOY_URL ?? "http://envoy-s.s-ns.svc.cluster.local:8080"
const AP_ENVOY_URL = process.env.AP_ENVOY_URL ?? "http://ap-envoy.ap-ns.svc.cluster.local:8080"
const BOB_OUTPROXY_URL = process.env.BOB_OUTPROXY_URL ?? "http://outproxy-bob.bob-ns.svc.cluster.local:9090"

describe("e2e-kind: Charlie pushes image directly to S", () => {
  let charlieKeypair: CryptoKeyPair
  let charliePrincipal: string
  let bobKeypair: CryptoKeyPair
  let bobPrincipal: string
  let apKeypair: CryptoKeyPair
  let apPrincipal: string
  let blobDigest: string
  let blobContent: Uint8Array
  let repoName: string

  beforeAll(async () => {
    // Load Charlie's keypair
    let charlieKeyPath = '/etc/dpop-keys/charlie.json'
    if (!await Bun.file(charlieKeyPath).exists()) {
      charlieKeyPath = '/tmp/paid-services-keys/charlie_dpop_key.json'
    }
    charlieKeypair = await loadKeypairFromPath(charlieKeyPath)
    const charliePubJwk = await crypto.subtle.exportKey("jwk", charlieKeypair.publicKey)
    charliePrincipal = await computePrincipal(charliePubJwk)
    repoName = `${charliePrincipal}/test`
    console.log("Charlie principal:", charliePrincipal)
    console.log("Repo name:", repoName)

    // Load Bob's keypair
    let bobKeyPath = '/etc/dpop-keys/bob.json'
    if (!await Bun.file(bobKeyPath).exists()) {
      bobKeyPath = '/tmp/paid-services-keys/bob_dpop_key.json'
    }
    bobKeypair = await loadKeypairFromPath(bobKeyPath)
    const bobPubJwk = await crypto.subtle.exportKey("jwk", bobKeypair.publicKey)
    bobPrincipal = await computePrincipal(bobPubJwk)
    console.log("Bob principal:", bobPrincipal)

    // Load AP's keypair
    let apKeyPath = '/etc/dpop-keys/ap.json'
    if (!await Bun.file(apKeyPath).exists()) {
      apKeyPath = '/tmp/paid-services-keys/ap_dpop_key.json'
    }
    apKeypair = await loadKeypairFromPath(apKeyPath)
    const apPubJwk = await crypto.subtle.exportKey("jwk", apKeypair.publicKey)
    apPrincipal = await computePrincipal(apPubJwk)
    console.log("AP principal:", apPrincipal)

    // Faucet Charlie's account on S
    const faucetSUrl = `${S_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetSProof = await generateProof(charlieKeypair, faucetSUrl, "POST")
    const faucetSRes = await fetch(faucetSUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetSProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: charliePrincipal, amount: 1_000_000_000 }),
    })
    expect(faucetSRes.status).toBe(200)
    console.log("Charlie fauceted on S")

    // Faucet AP's account on S
    const faucetAPSUrl = `${S_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetAPSProof = await generateProof(apKeypair, faucetAPSUrl, "POST")
    const faucetAPSRes = await fetch(faucetAPSUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetAPSProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: apPrincipal, amount: 1_000_000_000 }),
    })
    expect(faucetAPSRes.status).toBe(200)
    console.log("AP fauceted on S")

    // Faucet Bob's account on AP
    const faucetAPUrl = `${AP_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetAPProof = await generateProof(bobKeypair, faucetAPUrl, "POST")
    const faucetAPRes = await fetch(faucetAPUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetAPProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: bobPrincipal, amount: 1_000_000_000 }),
    })
    expect(faucetAPRes.status).toBe(200)
    console.log("Bob fauceted on AP")

    // Wait for Charlie's OCI
    console.log("Waiting for Charlie's OCI...")
    for (let i = 0; i < 60; i++) {
      try { await fetch(`${CHARLIE_OCI_URL}/v2/`); break } catch {}
      await sleep(1000)
    }
    console.log("Charlie's OCI ready")
  })

  it("Charlie pushes blob and manifest to S", async () => {
    // Create blob content
    blobContent = new Uint8Array(256)
    for (let i = 0; i < 256; i++) blobContent[i] = i
    blobDigest = `sha256:${createHash("sha256").update(Buffer.from(blobContent)).digest("hex")}`

    // Push blob through Charlie's OCI -> outproxy-charlie -> envoy-s -> kvstore-s
    const initRes = await fetch(`${CHARLIE_OCI_URL}/v2/${repoName}/blobs/uploads/`, {
      method: "POST",
      headers: { "x-user-id": charliePrincipal },
    })
    expect(initRes.status).toBe(202)
    const location = initRes.headers.get("Location")
    expect(location).toBeTruthy()
    const uploadUrl = new URL(location!, CHARLIE_OCI_URL)
    uploadUrl.searchParams.set("digest", blobDigest)
    const putRes = await fetch(uploadUrl.toString(), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "x-user-id": charliePrincipal },
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
    const manifestRes = await fetch(`${CHARLIE_OCI_URL}/v2/${repoName}/manifests/latest`, {
      method: "PUT",
      headers: { "Content-Type": "application/vnd.oci.image.manifest.v1+json", "x-user-id": charliePrincipal },
      body: JSON.stringify(manifest),
    })
    expect(manifestRes.status).toBe(201)
    console.log("Manifest pushed")

    // Verify blob accessible
    await sleep(2000)
    const getBlobRes = await fetch(`${CHARLIE_OCI_URL}/v2/${repoName}/blobs/${blobDigest}`, { headers: { "x-user-id": charliePrincipal } })
    expect(getBlobRes.status).toBe(200)
    const pulledBlob = new Uint8Array(await getBlobRes.arrayBuffer())
    expect(pulledBlob.length).toBe(256)
    expect(pulledBlob).toEqual(blobContent!)
    console.log("Charlie push verified")
  }, 60_000)

  it("Bob pulls image through AP via outproxy-bob", async () => {
    // Bob pulls through outproxy-bob -> envoy-ap -> oci-ap -> outproxy-ap -> envoy-s -> kvstore-s
    // outproxy-bob handles DPoP auth with Bob's keypair
    // Use in-cluster DNS for AP_ENVOY_URL because outproxy-bob (inside cluster) will forward to it
    const blobRes = await fetch(
      `http://ap-envoy.ap-ns.svc.cluster.local:8080/v2/${repoName}/blobs/${blobDigest}`,
      {
        method: "GET",
        // @ts-ignore - Bun's native proxy option
        proxy: BOB_OUTPROXY_URL,
      },
    )
    console.log("Bob pull blob status:", blobRes.status)
    if (blobRes.status !== 200) console.log("Body:", await blobRes.text())
    expect(blobRes.status).toBe(200)
    const pulledBlob = new Uint8Array(await blobRes.arrayBuffer())
    expect(pulledBlob.length).toBe(256)
    expect(pulledBlob).toEqual(blobContent!)
    console.log("Bob: blob pulled and verified")

    const manifestRes = await fetch(
      `http://ap-envoy.ap-ns.svc.cluster.local:8080/v2/${repoName}/manifests/latest`,
      {
        method: "GET",
        // @ts-ignore - Bun's native proxy option
        proxy: BOB_OUTPROXY_URL,
      },
    )
    console.log("Bob pull manifest status:", manifestRes.status)
    if (manifestRes.status !== 200) console.log("Body:", await manifestRes.text())
    expect(manifestRes.status).toBe(200)
    const pulledManifest = await manifestRes.json()
    expect(pulledManifest.schemaVersion).toBe(2)
    console.log("Bob: manifest pulled and verified")
  }, 60_000)

  it("Bob pull deduction changes when AP unit prices change", async () => {
    const faucetAPUrl = `${AP_ENVOY_URL}/account.v1.AccountService/CreditBalance`
    const faucetAPProof = await generateProof(bobKeypair, faucetAPUrl, "POST")
    const faucetAPRes = await fetch(faucetAPUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${faucetAPProof}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: bobPrincipal, amount: 10_000_000_000 }),
    })
    expect(faucetAPRes.status).toBe(200)

    const priceKey = `p::8080:/v2/${repoName}/manifests/latest`

    const setPrice = async (field: string, value: string) => {
      const proc = Bun.spawnSync([
        "kubectl", "exec", "-n", "ap-ns", "deploy/ap-redis", "--", "redis-cli",
        "HSET", priceKey, field, value,
      ])
      if (proc.exitCode !== 0) {
        throw new Error(`failed to set ${field} price: ${proc.stderr.toString()}`)
      }
    }
    const getBalance = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const rpc = Bun.spawnSync([
          "curl", "-sS", "-x", BOB_OUTPROXY_URL,
          "-H", `x-user-id: ${bobPrincipal}`,
          "-H", "Content-Type: application/json",
          "--data", JSON.stringify({ dummy: 1 }),
          "http://ap-envoy.ap-ns.svc.cluster.local:8080/account.v1.AccountService/GetBalance",
        ])
        if (rpc.exitCode === 0 && rpc.stdout.length > 0) {
          const data = JSON.parse(rpc.stdout.toString())
          return Number(data.balance ?? 0)
        }
        await sleep(200)
      }
      throw new Error("GetBalance failed after retries")
    }
    const pull = async () => {
      const res = await fetch(
        `http://ap-envoy.ap-ns.svc.cluster.local:8080/v2/${repoName}/manifests/latest`,
        { method: "GET", proxy: BOB_OUTPROXY_URL } as any,
      )
      if (res.status !== 200) {
        throw new Error(`pull failed: ${res.status} ${await res.text()}`)
      }
    }

    await setPrice("METER_TYPE_DURATION_MS", "0")
    await setPrice("METER_TYPE_INGRESS_BYTES", "1")
    await setPrice("METER_TYPE_EGRESS_BYTES", "1")
    const balanceBeforeLow = await getBalance()
    await pull()
    await sleep(2000)
    const balanceAfterLow = await getBalance()
    const lowDeduction = balanceBeforeLow - balanceAfterLow
    expect(lowDeduction).toBeGreaterThan(0)

    await setPrice("METER_TYPE_DURATION_MS", "0")
    await setPrice("METER_TYPE_INGRESS_BYTES", "10")
    await setPrice("METER_TYPE_EGRESS_BYTES", "10")
    const balanceBeforeHigh = await getBalance()
    await pull()
    await sleep(2000)
    const balanceAfterHigh = await getBalance()
    const highDeduction = balanceBeforeHigh - balanceAfterHigh
    expect(highDeduction).toBeGreaterThan(lowDeduction)
    expect(highDeduction).toBe(lowDeduction * 10)
    console.log("Bob pull deductions:", { lowDeduction, highDeduction })
  }, 60_000)

  it("Meter feedback works with deterministic external request ID", async () => {
    // Use a deterministic external request ID to test meter feedback
    const feedbackId = crypto.randomUUID()
    const feedbackRepo = `${charliePrincipal}/feedback-test`
    const feedbackBlob = new Uint8Array(64)
    for (let i = 0; i < 64; i++) feedbackBlob[i] = i
    const feedbackBlobDigest = `sha256:${createHash("sha256").update(Buffer.from(feedbackBlob)).digest("hex")}`

    const feedbackPaths = [
      `/kvstore.v1.MeteredStorageService/CreateCASValue`,
    ]
    for (const path of feedbackPaths) {
      const priceKey = `p::8080:${path}`
      const proc = Bun.spawnSync([
        "kubectl", "exec", "-n", "s-ns", "deploy/s-redis", "--", "redis-cli",
        "HSET", priceKey,
        "METER_TYPE_DURATION_MS", "1",
        "METER_TYPE_INGRESS_BYTES", "1",
        "METER_TYPE_EGRESS_BYTES", "1",
      ])
      expect(proc.exitCode).toBe(0)
    }

    // Push with deterministic x-external-request-id
    // outproxy-charlie will pass it through instead of generating a new one
    const initRes = await fetch(`${CHARLIE_OCI_URL}/v2/${feedbackRepo}/blobs/uploads/`, {
      method: "POST",
      headers: {
        "x-user-id": charliePrincipal,
        "x-external-request-id": feedbackId,
      },
    })
    expect(initRes.status).toBe(202)
    const location = initRes.headers.get("Location")
    const uploadUrl = new URL(location!, CHARLIE_OCI_URL)
    uploadUrl.searchParams.set("digest", feedbackBlobDigest)
    const putRes = await fetch(uploadUrl.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-user-id": charliePrincipal,
        "x-external-request-id": feedbackId,
      },
      body: feedbackBlob,
    })
    expect(putRes.status).toBe(201)
    console.log("Feedback blob uploaded with external request ID:", feedbackId)

    // Wait for ALS to process meter feedback within its configured TTL
    await sleep(5000)

    // Query S's GetMeterFeedback with the deterministic ID
    const feedbackUrl = `${S_ENVOY_URL}/account.v1.AccountService/GetMeterFeedback`
    const feedbackProof = await generateProof(charlieKeypair, feedbackUrl, "POST")
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
