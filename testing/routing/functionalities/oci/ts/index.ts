import { KvstoreClient } from "../../../../../applications/oci/src/storage/kvstore.ts"
import type { Definition, Functionality } from "../../../../../applications/router/src/lib.ts"
export { KvstoreClient }
export interface Layer { digest: string; size: number; annotations: { "org.opencontainers.image.title": string } }
export async function digest(bytes: Uint8Array): Promise<string> { return "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex") }
export async function publish(client: KvstoreClient, owner: string, name: string, tag: string, files: Record<string, Uint8Array>): Promise<Layer[]> {
  const layers: Layer[] = []
  for (const [title, bytes] of Object.entries(files)) {
    const hash = await digest(bytes)
    await client.putBlob(hash, bytes)
    layers.push({ digest: hash, size: bytes.length, annotations: { "org.opencontainers.image.title": title } })
  }
  const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { mediaType: "application/octet-stream", digest: layers[0].digest, size: layers[0].size }, layers: layers.map(l => ({ ...l, mediaType: "text/plain" })) }))
  await client.putBlob(await digest(manifest), manifest)
  await client.putManifestTag(`${owner}/${name}`, tag, manifest, Date.now())
  return layers
}
export async function loadDefinition(client: KvstoreClient, definition: Definition): Promise<Record<string, Uint8Array>> {
  const manifest = await client.getManifestTag(`${definition.maintainer}/${definition.name}`, definition.tag, definition.maintainer)
  if (!manifest) throw new Error("definition signature or content invalid")
  const parsed = JSON.parse(new TextDecoder().decode(manifest))
  const files: Record<string, Uint8Array> = {}
  for (const layer of parsed.layers as Layer[]) {
    const content = await client.getBlob(layer.digest)
    if (!content || await digest(content) !== layer.digest) throw new Error("definition content digest mismatch")
    files[layer.annotations["org.opencontainers.image.title"]] = content
  }
  return files
}
export async function loadFunctionality(client: KvstoreClient, functionality: Functionality) {
  const behavior = await loadDefinition(client, functionality.behavior)
  const variant = await loadDefinition(client, functionality.variant)
  const text = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))
  const link = text(variant["behavior.json"])
  if (JSON.stringify(link.behavior) !== JSON.stringify(functionality.behavior)) throw new Error("variant references another behavior")
  const collection = text(variant["variant.json"])
  if (collection.owner !== functionality.variant.maintainer) throw new Error("collection owner differs from variant maintainer")
  return { behavior, variant, collection }
}

// The OCI behavior is known by the importing application. Each signed storage
// variant names one repository, so the index can locate definition storage
// using the same exact functionality matching as ordinary service discovery.
export function definitionStorage(definition: Definition, ociBehavior: Definition): Functionality {
  return { behavior: ociBehavior, variant: { ...definition, name: `${definition.name}-storage` } }
}
