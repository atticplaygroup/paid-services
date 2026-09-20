import { describe, expect, it, mock } from "bun:test"
import { createOciApp, type OciDeps } from "./server.js"
import type { MeterClient } from "./meter.js"
import type { KvstoreClient } from "./storage/kvstore.js"

const manifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: "sha256:0000", size: 10 },
  layers: [],
}

let manifestPut = false

function fakeDeps(overrides?: Partial<OciDeps>): OciDeps {
  return {
    kvstore: {
      getBlob: mock(async () => new Uint8Array([1, 2, 3])),
      putBlob: mock(async () => {}),
      getManifestTag: mock(async (_name: string, tag: string) => tag === "latest" ? new TextEncoder().encode(JSON.stringify(manifest)) : null),
      putManifestTag: mock(async () => {}),
      listTags: mock(async () => ({ name: "alice/testrepo", tags: manifestPut ? ["v1.0"] : [] })),
      putTagList: mock(async () => { manifestPut = true }),
    } as unknown as KvstoreClient,
    meter: {
      reportUsage: mock(async () => true),
    } as unknown as MeterClient,
    ...overrides,
  }
}

describe("OCI /v2/ endpoints", () => {
  it("GET /v2/ returns 200", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(new Request("http://test/v2/"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it("GET /v2/:name/blobs/:digest returns 200 with blob bytes", async () => {
    const deps = fakeDeps()
    deps.kvstore.getBlob = mock(async () => new Uint8Array([4, 5, 6]))
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(res.headers.get("Docker-Content-Digest")).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    const body = await res.arrayBuffer()
    expect(new Uint8Array(body)).toEqual(new Uint8Array([4, 5, 6]))
  })

  it("GET /v2/:name/blobs/:digest returns 404 for missing blob", async () => {
    const deps = fakeDeps()
    deps.kvstore.getBlob = mock(async () => null)
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/sha256:0000000000000000000000000000000000000000000000000000000000000001", {
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(404)
  })

  it("GET /v2/:name/blobs/:digest returns 400 for invalid digest", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/not-a-valid-digest", { headers: { "x-user-id": "alice" } }),
    )
    expect(res.status).toBe(400)
  })

  it("HEAD /v2/:name/blobs/:digest returns 200 for existing blob", async () => {
    const deps = fakeDeps()
    deps.kvstore.getBlob = mock(async () => new Uint8Array([1]))
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        method: "HEAD",
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(200)
  })

  it("HEAD /v2/:name/blobs/:digest returns 404 for missing blob", async () => {
    const deps = fakeDeps()
    deps.kvstore.getBlob = mock(async () => null)
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/sha256:0000000000000000000000000000000000000000000000000000000000000001", {
        method: "HEAD",
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(404)
  })

  it("POST /v2/:name/blobs/uploads/ returns 202 with auth", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/uploads/", {
        method: "POST",
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(202)
    expect(res.headers.get("Location")).toMatch(/^\/v2\/alice\/testrepo\/blobs\/uploads\//)
  })

  it("POST /v2/:name/blobs/uploads/ returns 401 without auth", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/uploads/", { method: "POST" }),
    )
    expect(res.status).toBe(401)
  })

  it("PUT /v2/:name/blobs/uploads/:uuid stores blob and returns 201", async () => {
    const deps = fakeDeps()
    deps.kvstore.putBlob = mock(async () => {})
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/uploads/test-uuid-123?digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        method: "PUT",
        headers: { "x-user-id": "alice" },
        body: new Uint8Array([7, 8, 9]),
      }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get("Docker-Content-Digest")).toBe("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
  })

  it("PUT /v2/:name/blobs/uploads/:uuid returns 400 without digest", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/uploads/test-uuid", {
        method: "PUT",
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(400)
  })

  it("PUT /v2/:name/blobs/uploads/:uuid returns 402 when deduction fails", async () => {
    const deps = fakeDeps()
    deps.meter.reportUsage = mock(async () => false)
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/blobs/uploads/test-uuid?digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
        method: "PUT",
        headers: { "x-user-id": "alice" },
      }),
    )
    expect(res.status).toBe(402)
  })
})

describe("OCI manifest endpoints", () => {
  it("PUT /v2/:name/manifests/:ref stores and returns 201", async () => {
    const deps = fakeDeps()
    const app = createOciApp(deps)
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/manifests/latest", {
        method: "PUT",
        headers: { "x-user-id": "alice", "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        body: JSON.stringify(manifest),
      }),
    )
    expect(res.status).toBe(201)
    expect(res.headers.get("Docker-Content-Digest")).toMatch(/^sha256:/)
  })

  it("GET /v2/:name/manifests/:ref returns stored manifest", async () => {
    const deps = fakeDeps()
    const app = createOciApp(deps)
    await app.fetch(
      new Request("http://test/v2/alice/testrepo/manifests/latest", {
        method: "PUT",
        headers: { "x-user-id": "alice", "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        body: JSON.stringify(manifest),
      }),
    )
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/manifests/latest"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.schemaVersion).toBe(2)
    expect(body.mediaType).toBe("application/vnd.oci.image.manifest.v1+json")
  })

  it("GET /v2/:name/manifests/:ref returns 404 for unknown ref", async () => {
    const app = createOciApp(fakeDeps())
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/manifests/unknown"),
    )
    expect(res.status).toBe(404)
  })

  it("GET /v2/:name/tags/list returns tags for repo", async () => {
    const deps = fakeDeps()
    const app = createOciApp(deps)
    await app.fetch(
      new Request("http://test/v2/alice/testrepo/manifests/v1.0", {
        method: "PUT",
        headers: { "x-user-id": "alice", "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        body: JSON.stringify(manifest),
      }),
    )
    const res = await app.fetch(
      new Request("http://test/v2/alice/testrepo/tags/list"),
    )
    expect(res.status).toBe(200)
    const tags = await res.json()
    expect(tags.name).toBe("alice/testrepo")
    expect(tags.tags).toContain("v1.0")
  })
})
