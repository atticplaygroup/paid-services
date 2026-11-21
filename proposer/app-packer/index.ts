import { readdir, mkdir, writeFile } from "node:fs/promises"
import { resolve, relative, join } from "node:path"
import { KvstoreClient } from "../../applications/oci/src/storage/kvstore.ts"

export { KvstoreClient }
export interface Publication { maintainer: string; name: string; tag: string }
interface Layer { digest: string; size: number; annotations: { "org.opencontainers.image.title": string } }
export async function digest(bytes: Uint8Array): Promise<string> {
  return "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex")
}

/** Publish files as OCI layers, anchored by the client's signing key. */
export async function publishFiles(client: KvstoreClient, publication: Publication, files: Record<string, Uint8Array>): Promise<void> {
  const layers: Layer[] = []
  if (!Object.keys(files).length) throw new Error("empty publication")
  for (const [title, bytes] of Object.entries(files)) {
    safePath(title)
    const hash = await digest(bytes)
    await client.putBlob(hash, bytes)
    layers.push({ digest: hash, size: bytes.length, annotations: { "org.opencontainers.image.title": title } })
  }
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/octet-stream", digest: layers[0].digest, size: layers[0].size },
    layers: layers.map(layer => ({ ...layer, mediaType: "application/octet-stream" })),
  }))
  await client.putBlob(await digest(manifest), manifest)
  await client.putManifestTag(`${publication.maintainer}/${publication.name}`, publication.tag, manifest, Date.now())
}

/** Verify the expected proposer's anchor and every layer before returning files. */
export async function downloadFiles(client: KvstoreClient, publication: Publication): Promise<Record<string, Uint8Array>> {
  const manifest = await client.getManifestTag(`${publication.maintainer}/${publication.name}`, publication.tag, publication.maintainer)
  if (!manifest) throw new Error("publication signature or manifest invalid")
  const parsed = JSON.parse(new TextDecoder().decode(manifest))
  if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.layers)) throw new Error("invalid OCI manifest")
  const files: Record<string, Uint8Array> = Object.create(null)
  for (const layer of parsed.layers as Layer[]) {
    const title = layer.annotations?.["org.opencontainers.image.title"]
    safePath(title)
    if (Object.hasOwn(files, title)) throw new Error("duplicate OCI filename")
    const bytes = await client.getBlob(layer.digest)
    if (!bytes || bytes.length !== layer.size || await digest(bytes) !== layer.digest) throw new Error("publication layer digest mismatch")
    files[title] = bytes
  }
  return files
}

function safePath(name: string): void {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("unsafe OCI filename")
}

/** Bundle JS inline: file:// launches need no local module fetches or server. */
export async function packFrontend(entrypoint: string, config: unknown, template = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'): Promise<Record<string, Uint8Array>> {
  const result = await Bun.build({ entrypoints: [entrypoint], target: "browser", minify: true })
  if (!result.success) throw new AggregateError(result.logs, "frontend build failed")
  if (result.outputs.length !== 1) throw new Error("frontend must produce one JavaScript bundle")
  const script = (await result.outputs[0].text()).replace(/<\/script/gi, "<\\/script")
  const serialized = JSON.stringify(config).replace(/</g, "\\u003c")
  if (!template.includes("</body>")) throw new Error("frontend template must contain </body>")
  const scripts = `<script>globalThis.PAID_CONFIG=${serialized};</script><script type="module">${script}</script>`
  const html = template.replace("</body>", () => scripts + "</body>")
  return { "index.html": new TextEncoder().encode(html) }
}

export async function publishDirectory(client: KvstoreClient, publication: Publication, directory: string): Promise<void> {
  const root = resolve(directory)
  const files: Record<string, Uint8Array> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[relative(root, path).split("\\").join("/")] = new Uint8Array(await Bun.file(path).arrayBuffer())
  }
  await publishFiles(client, publication, files)
}

/** Use a new, empty destination to avoid overwriting existing files or symlinks. */
export async function downloadToDirectory(client: KvstoreClient, publication: Publication, directory: string): Promise<string> {
  const files = await downloadFiles(client, publication)
  await mkdir(directory)
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(directory, name)
    await mkdir(resolve(path, ".."), { recursive: true })
    await writeFile(path, bytes, { flag: "wx" })
  }
  return join(resolve(directory), "index.html")
}
