import { test, expect } from "bun:test"
import { publishFiles, downloadFiles, downloadToDirectory, packFrontend } from "./index.ts"

function storage() {
  const blobs = new Map<string, Uint8Array>()
  let manifest: Uint8Array
  const client = {
    async putBlob(hash: string, bytes: Uint8Array) { blobs.set(hash, bytes) },
    async putManifestTag(_name: string, _tag: string, bytes: Uint8Array) { manifest = bytes },
    async getManifestTag() { return manifest },
    async getBlob(hash: string) { return blobs.get(hash) },
  }
  return { client: client as any, blobs, manifest: () => manifest }
}
const publication = { maintainer: "proposer", name: "app", tag: "v1" }

test("download checks every layer, rejecting changed content before writing", async () => {
  const store = storage()
  await publishFiles(store.client, publication, { "index.html": new TextEncoder().encode("authentic") })
  expect(new TextDecoder().decode((await downloadFiles(store.client, publication))["index.html"])).toBe("authentic")
  const layer = JSON.parse(new TextDecoder().decode(store.manifest())).layers[0]
  store.blobs.set(layer.digest, new TextEncoder().encode("malicious"))
  await expect(downloadToDirectory(store.client, publication, "/unreachable/not-created")).rejects.toThrow("digest mismatch")
})

test("rejects traversal and duplicate layer names", async () => {
  const store = storage()
  await expect(publishFiles(store.client, publication, { "../escape": new Uint8Array() })).rejects.toThrow("unsafe OCI filename")
  await publishFiles(store.client, publication, { "index.html": new Uint8Array() })
  const parsed = JSON.parse(new TextDecoder().decode(store.manifest()))
  parsed.layers.push(parsed.layers[0])
  store.client.getManifestTag = async () => new TextEncoder().encode(JSON.stringify(parsed))
  await expect(downloadFiles(store.client, publication)).rejects.toThrow("duplicate OCI filename")
})

test("frontend bundle contains no local module dependency and no closing script injection", async () => {
  const files = await packFrontend(new URL("../../examples/echo-server/frontend/index.ts", import.meta.url).pathname, { indices: ["</script><script>alert(1)</script>"] })
  const html = new TextDecoder().decode(files["index.html"])
  expect(html).not.toContain("</script><script>alert(1)")
  expect(html).not.toContain('src="')
  expect(html).toContain("PAID_CONFIG=")
})
