import { Hono } from "hono"
import { cors } from "hono/cors"
import { authMiddleware, getUserId } from "./auth.js"
import type { KvstoreClient } from "./storage/kvstore.js"
import type { MeterClient } from "./meter.js"
import { digestOf } from "./digest.js"

/** Parse sha256:hex digest and extract the hex part for validation. */
function parseDigest(digest: string): { algo: string; hex: string } | null {
  const m = /^(sha256):([a-f0-9]{64})$/.exec(digest)
  return m ? { algo: m[1], hex: m[2] } : null
}

/** Generate a UUID v4 for upload sessions. */
function uuidv4(): string {
  return crypto.randomUUID()
}

function repoName(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

export interface OciDeps {
  kvstore: KvstoreClient
  meter: MeterClient
  readOnly?: boolean
}

export function createOciApp(deps: OciDeps): Hono {
  const app = new Hono()

  app.use("*", cors())

  app.get("/v2/", (c) => c.json({}))

  // ---- Blob endpoints (always) ----
  app.get("/v2/:owner/:repo/blobs/:digest", authMiddleware, async (c) => {
    const { digest } = c.req.param()
    const dp = parseDigest(digest)
    if (!dp) {
      c.status(400)
      return c.json({ errors: [{ code: "BLOB_UNKNOWN", message: `invalid digest: ${digest}` }] })
    }
    const blob = await deps.kvstore.getBlob(digest)
    if (!blob) {
      c.status(404)
      return c.json({ errors: [{ code: "BLOB_UNKNOWN", message: `blob not found: ${digest}` }] })
    }
    c.header("Content-Type", "application/octet-stream")
    c.header("Docker-Content-Digest", digest)
    return c.body(blob as any)
  })

  app.on("HEAD", "/v2/:owner/:repo/blobs/:digest", authMiddleware, async (c) => {
    const { digest } = c.req.param()
    const dp = parseDigest(digest)
    if (!dp) { c.status(400); return c.body(null) }
    const blob = await deps.kvstore.getBlob(digest)
    if (!blob) { c.status(404); return c.body(null) }
    return c.body(null)
  })

  // ---- Manifest endpoints (always — kvstore-backed) ----
  app.get("/v2/:owner/:repo/manifests/:ref", async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)

    let body: Uint8Array | null = null

    // Try tag lookup first
    body = await deps.kvstore.getManifestTag(name, ref, owner)
    if (!body && ref.startsWith("sha256:")) {
      // Content-addressed blob lookup
      const blob = await deps.kvstore.getBlob(ref)
      if (blob) body = blob
    }

    if (!body) {
      c.status(404)
      return c.json({ errors: [{ code: "MANIFEST_UNKNOWN", message: `manifest not found: ${ref}` }] })
    }
    const digest = digestOf(body)
    c.header("Docker-Content-Digest", digest)
    c.header("Content-Type", "application/vnd.oci.image.manifest.v1+json")
    return c.json(JSON.parse(new TextDecoder().decode(body)))
  })

  // ---- Tags endpoint (kvstore-backed) ----
  app.get("/v2/:owner/:repo/tags/list", async (c) => {
    const { owner, repo } = c.req.param()
    const name = repoName(owner, repo)
    const tags = await deps.kvstore.listTags(name, owner)
    return c.json(tags)
  })

  // ---- Write endpoints (only when !readOnly) ----
  if (!deps.readOnly) {

  app.post("/v2/:owner/:repo/blobs/uploads/", authMiddleware, async (c) => {
    const { owner, repo } = c.req.param()
    const userId = getUserId(c)
    const allowed = await deps.meter.reportUsage(uuidv4(), userId)
    if (!allowed) {
      c.status(402)
      return c.json({ errors: [{ code: "PAYMENT_REQUIRED", message: "deduction failed" }] })
    }
    const uuid = uuidv4()
    c.header("Location", `/v2/${repoName(owner, repo)}/blobs/uploads/${uuid}`)
    c.header("Range", "0-0")
    c.status(202)
    return c.json({ uuid })
  })

  app.put("/v2/:owner/:repo/blobs/uploads/:uuid", authMiddleware, async (c) => {
    const digest = c.req.query("digest")
    const userId = getUserId(c)
    const externalRequestId = c.req.header("x-external-request-id")
    if (!digest) {
      c.status(400)
      return c.json({ errors: [{ code: "DIGEST_INVALID", message: "digest query parameter required" }] })
    }
    if (!parseDigest(digest)) {
      c.status(400)
      return c.json({ errors: [{ code: "DIGEST_INVALID", message: `invalid digest: ${digest}` }] })
    }
    const allowed = await deps.meter.reportUsage(uuidv4(), userId)
    if (!allowed) { c.status(402); return c.json({ errors: [{ code: "PAYMENT_REQUIRED", message: "deduction failed" }] }) }
    const body = await c.req.arrayBuffer()
    try {
      await deps.kvstore.putBlob(digest, new Uint8Array(body), userId, externalRequestId)
    } catch (err) {
      console.error("putBlob error:", err)
      c.status(500)
      return c.json({ errors: [{ code: "BLOB_UPLOAD_FAILED", message: "failed to store blob" }] })
    }
    c.header("Docker-Content-Digest", digest)
    c.status(201)
    return c.body(null)
  })

  app.put("/v2/:owner/:repo/manifests/:ref", authMiddleware, async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)
    const userId = getUserId(c)
    const externalRequestId = c.req.header("x-external-request-id")
    const body = await c.req.text()

    const digestParam = c.req.query("digest")
    if (digestParam) {
      const actualDigest = digestOf(new TextEncoder().encode(body))
      if (digestParam !== actualDigest) {
        c.status(400)
        return c.json({ errors: [{ code: "MANIFEST_INVALID", message: "digest mismatch" }] })
      }
    }

    const allowed = await deps.meter.reportUsage(uuidv4(), userId)
    if (!allowed) {
      c.status(402)
      return c.json({ errors: [{ code: "PAYMENT_REQUIRED", message: "deduction failed" }] })
    }

    const bodyBytes = new TextEncoder().encode(body)
    const digest = digestOf(bodyBytes)
    await deps.kvstore.putBlob(digest, bodyBytes, userId, externalRequestId)
    await deps.kvstore.putManifestTag(name, ref, userId, bodyBytes, Date.now(), userId, externalRequestId)
    // Update tag list
    const existingTags = await deps.kvstore.listTags(name, userId)
    const tagNames = existingTags.tags
    if (!tagNames.includes(ref)) {
      tagNames.push(ref)
      await deps.kvstore.putTagList(name, tagNames, userId, userId, externalRequestId)
    }

    c.header("Location", `/v2/${name}/manifests/${digest}`)
    c.header("Docker-Content-Digest", digest)
    c.status(201)
    return c.body(null)
  })

  app.delete("/v2/:owner/:repo/manifests/:ref", authMiddleware, async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)
    const userId = getUserId(c)
    // Remove from tag list
    const existingTags = await deps.kvstore.listTags(name, userId)
    const tagNames = existingTags.tags.filter((t: string) => t !== ref)
    await deps.kvstore.putTagList(name, tagNames, userId, userId)
    c.status(202)
    return c.body(null)
  })

  } // end !readOnly

  return app
}
