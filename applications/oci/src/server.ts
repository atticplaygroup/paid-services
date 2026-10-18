import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Context, Next } from "hono"
import { authMiddleware, getRequestId, getRequestIdentity, getUserId } from "./auth.js"
import type { KvstoreClient } from "./storage/kvstore.js"
import { withRequestIdentity } from "./storage/kvstore.js"
import type { MeterClient } from "./meter.js"
import { digestOf } from "./digest.js"

/** Parse sha256:hex digest and extract the hex part for validation. */
function parseDigest(digest: string): { algo: string; hex: string } | null {
  const m = /^(sha256):([a-f0-9]{64})$/.exec(digest)
  return m ? { algo: m[1], hex: m[2] } : null
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
    const blob = await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.getBlob(digest))
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
    const blob = await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.getBlob(digest))
    if (!blob) { c.status(404); return c.body(null) }
    return c.body(null)
  })

  // ---- Manifest endpoints (always — kvstore-backed) ----
  app.get("/v2/:owner/:repo/manifests/:ref", async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)

    let body: Uint8Array | null = null

    // Try tag lookup first
    body = await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.getManifestTag(name, ref, owner))
    if (!body && ref.startsWith("sha256:")) {
      // Content-addressed blob lookup
      const blob = await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.getBlob(ref))
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
    const tags = await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.listTags(name, owner))
    return c.json(tags)
  })

  // ---- Write endpoints (only when !readOnly) ----
  if (!deps.readOnly) {
  const paymentMiddleware = async (c: Context, next: Next) => {
    const allowed = await deps.meter.reportUsage(getRequestId(c), getUserId(c))
    if (!allowed) {
      c.status(402)
      return c.json({ errors: [{ code: "PAYMENT_REQUIRED", message: "deduction failed" }] })
    }
    await next()
  }

  app.post("/v2/:owner/:repo/blobs/uploads/", authMiddleware, paymentMiddleware, async (c) => {
    const { owner, repo } = c.req.param()
    const uploadId = Bun.randomUUIDv7()
    c.header("Location", `/v2/${repoName(owner, repo)}/blobs/uploads/${uploadId}`)
    c.header("Range", "0-0")
    c.status(202)
    return c.json({ uploadId })
  })

  app.put("/v2/:owner/:repo/blobs/uploads/:uploadId", authMiddleware, paymentMiddleware, async (c) => {
    const digest = c.req.query("digest")
    if (!digest) {
      c.status(400)
      return c.json({ errors: [{ code: "DIGEST_INVALID", message: "digest query parameter required" }] })
    }
    if (!parseDigest(digest)) {
      c.status(400)
      return c.json({ errors: [{ code: "DIGEST_INVALID", message: `invalid digest: ${digest}` }] })
    }
    const body = await c.req.arrayBuffer()
    try {
      await withRequestIdentity(getRequestIdentity(c), () => deps.kvstore.putBlob(digest, new Uint8Array(body)))
    } catch (err) {
      console.error("putBlob error:", err)
      c.status(500)
      return c.json({ errors: [{ code: "BLOB_UPLOAD_FAILED", message: "failed to store blob" }] })
    }
    c.header("Docker-Content-Digest", digest)
    c.status(201)
    return c.body(null)
  })

  app.put("/v2/:owner/:repo/manifests/:ref", authMiddleware, paymentMiddleware, async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)
    const body = await c.req.text()

    const digestParam = c.req.query("digest")
    if (digestParam) {
      const actualDigest = digestOf(new TextEncoder().encode(body))
      if (digestParam !== actualDigest) {
        c.status(400)
        return c.json({ errors: [{ code: "MANIFEST_INVALID", message: "digest mismatch" }] })
      }
    }

    const bodyBytes = new TextEncoder().encode(body)
    const digest = digestOf(bodyBytes)
    await withRequestIdentity(getRequestIdentity(c), async () => {
      await deps.kvstore.putBlob(digest, bodyBytes)
      await deps.kvstore.putManifestTag(name, ref, bodyBytes, Date.now())
      const existingTags = await deps.kvstore.listTags(name, owner)
      const tagNames = existingTags.tags
      if (!tagNames.includes(ref)) {
        tagNames.push(ref)
        await deps.kvstore.putTagList(name, tagNames)
      }
    })

    c.header("Location", `/v2/${name}/manifests/${digest}`)
    c.header("Docker-Content-Digest", digest)
    c.status(201)
    return c.body(null)
  })

  app.delete("/v2/:owner/:repo/manifests/:ref", authMiddleware, async (c) => {
    const { owner, repo, ref } = c.req.param()
    const name = repoName(owner, repo)
    // Remove from tag list
    await withRequestIdentity(getRequestIdentity(c), async () => {
      const existingTags = await deps.kvstore.listTags(name, owner)
      const tagNames = existingTags.tags.filter((t: string) => t !== ref)
      await deps.kvstore.putTagList(name, tagNames)
    })
    c.status(202)
    return c.body(null)
  })

  } // end !readOnly

  return app
}
