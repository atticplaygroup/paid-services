import { importer } from "ipfs-unixfs-importer"
import { MemoryBlockstore } from "blockstore-core/memory"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
export async function packFiles(files: Record<string, Uint8Array>) {
  const blockstore = new MemoryBlockstore()
  const cids = new Map<string, CID>()
  const put = blockstore.put.bind(blockstore)
  blockstore.put = ((cid, value, options) => { cids.set(cid.toString(), cid); return put(cid, value, options) }) as typeof blockstore.put
  let root: CID | undefined
  for await (const entry of importer(Object.entries(files).map(([path, content]) => ({ path, content })), blockstore, { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true })) root = entry.cid
  if (!root) throw new Error("cannot pack empty application")
  const blocks = new Map<string, Uint8Array>()
  for (const [key, cid] of cids) {
    const chunks: Uint8Array[] = []
    for await (const chunk of blockstore.get(cid)) chunks.push(chunk)
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    blocks.set(key, bytes)
  }
  return { root, blocks }
}
export async function publishBlocks(blocks: Map<string, Uint8Array>, storage: string, paid: typeof fetch) {
  for (const [key, value] of blocks) {
    const response = await paid(storage + "/kvstore.v1.MeteredStorageService/CreateCASValue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storageBackend: "STORAGE_BACKEND_BLOB_STORAGE", codec: CID.parse(key).code === 0x55 ? "CODEC_RAW" : "CODEC_DAG_PB", key, ttl: "2592000s", value: Buffer.from(value).toString("base64") }) })
    if (!response.ok) throw new Error(`publish ${key}: ${response.status} ${await response.text()}`)
  }
}
export async function publishRaw(bytes: Uint8Array, storage: string, paid: typeof fetch) {
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
  await publishBlocks(new Map([[cid, bytes]]), storage, paid)
  return cid
}
export async function carBytes(root: CID, blocks: Map<string, Uint8Array>) {
  const { CarWriter } = await import("@ipld/car")
  const { writer, out } = CarWriter.create([root])
  const drain = (async () => { const chunks: Uint8Array[] = []; for await (const chunk of out) chunks.push(chunk); return Buffer.concat(chunks) })()
  for (const [id, bytes] of blocks) await writer.put({ cid: CID.parse(id), bytes })
  await writer.close()
  return drain
}
