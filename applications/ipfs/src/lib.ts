// Adapted from atticplaygroup/pua's PkvBlockBroker (Apache-2.0): keep Helia's
// broker boundary, replace legacy sessions/exchanges with PAID routed proofs.
import { paidIndexRouting } from "./routing.ts"
import { delegatedHTTPRouting } from "@helia/routers"
import { createHeliaLight } from "helia"
import { createVerifiedFetchWithHelia } from "@helia/verified-fetch"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import type { BlockBroker, BlockRetrievalOptions } from "@helia/interface"
import type { Functionality } from "../../router/src/lib.ts"
export interface PaidIpfsConfig { fetch: typeof fetch; objects: Functionality; bucket?: string; blockGateway?: string; gatewayFetch?: typeof fetch; indices?: string[]; indexFetch?: typeof fetch; delegatedRoutingUrl?: string }
// Helia wraps broker errors in AggregateErrors. Keep their causes visible at
// the fetch boundary instead of reporting only "Failed to load block".
export function blockFailureDetails(error: unknown, seen = new Set<unknown>()): string {
  if (seen.has(error)) return ""
  seen.add(error)
  if (!(error instanceof Error)) return String(error)
  const nested = [...(Array.isArray((error as any).errors) ? (error as any).errors : []), ...(error.cause ? [error.cause] : [])]
  return [error.message, ...nested.map(e => blockFailureDetails(e, seen))].filter(Boolean).join("; ")
}
export function paidBlockBroker(config: PaidIpfsConfig, routing?: any): BlockBroker {
  return { name: "paid-s3", async retrieve(cid: CID, options?: BlockRetrievalOptions) {
    const origins: string[] = []
    if (config.blockGateway) origins.push(config.blockGateway)
    else if (routing) { for await (const provider of routing.findProviders(cid, options)) if (provider.origin) origins.push(provider.origin) }
    else origins.push("https://paid.invalid")
    const failures: Error[] = []
    for (const origin of origins) {
    try {
    const source = config.blockGateway ? `${origin}/ipfs/${cid}?format=raw` : `${origin}/${config.bucket ?? "applications"}/user/public/value/${cid}`
    const response = await (config.blockGateway ? config.gatewayFetch ?? config.fetch : config.indexFetch ?? config.fetch)(source, { headers: routing || config.blockGateway ? {} : { "X-PAID-Functionality": JSON.stringify(config.objects) }, signal: options?.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value = new Uint8Array(await response.arrayBuffer())
    const digest = await sha256.digest(value)
    if (cid.multihash.code !== digest.code || !digest.bytes.every((b, i) => b === cid.multihash.bytes[i]) || digest.bytes.length !== cid.multihash.bytes.length) throw new Error(`IPFS block integrity mismatch: ${cid}`)
    await options?.validateFn?.(value)
    return value
    } catch (error) { failures.push(new Error(`Block ${cid} from ${origin} failed`, { cause: error })) }
    }
    if (failures.length) throw new AggregateError(failures, `All block providers failed for ${cid}`)
    throw new Error(`No IPFS provider for ${cid}`)
  } }
}
export async function createPaidVerifiedFetch(config: PaidIpfsConfig) {
  // Discovery goes through config.fetch's index-backed PAID routing. No public
  // IPFS gateways or hidden unmetered network fallback are enabled.
  const routers: any[] = []
  // verified-fetch converts Helia's error to a plain 504 response, discarding
  // its nested causes. Retain bounded per-block failures to explain that response.
  const failures = new Map<string, unknown>()
  if (!config.blockGateway && config.indices?.length) {
    const index = paidIndexRouting({ indices: config.indices, functionality: config.objects, fetch: config.indexFetch ?? config.fetch })
    routers.push({ ...index, async *findProviders(cid: CID, options: any) {
      try { yield* index.findProviders(cid, options) }
      catch (error) { failures.set(cid.toString(), error); throw error }
    } })
  }
  if (config.delegatedRoutingUrl) routers.push(delegatedHTTPRouting({ url: config.delegatedRoutingUrl }))
  const helia = createHeliaLight({ blockBrokers: [components => {
    const broker = paidBlockBroker(config, !config.blockGateway && config.indices?.length ? components.routing : undefined)
    return { ...broker, async retrieve(cid: CID, options?: BlockRetrievalOptions) {
      const key = cid.toString()
      failures.delete(key)
      try {
        const value = await broker.retrieve!(cid, options)
        failures.delete(key)
        return value
      }
      catch (error) {
        failures.set(key, failures.has(key) ? new AggregateError([failures.get(key), error], `File discovery and retrieval failed for ${cid}`) : error)
        if (failures.size > 64) failures.delete(failures.keys().next().value!)
        throw error
      }
    } }
  }], routers })
  await helia.start()
  const verified = await createVerifiedFetchWithHelia(helia)
  return { fetch: async (url: string, init?: any) => {
    try {
      const response = await verified(url, { ...init, session: false })
      if (response.status !== 504) return response
      const text = await response.text()
      const cid = /^LoadBlockFailedError: Failed to load block for (\S+)\s*$/.exec(text)?.[1]
      const failure = cid ? failures.get(cid) : undefined
      const headers = new Headers(response.headers)
      headers.delete("content-length")
      return new Response(failure ? `${text}\n${blockFailureDetails(failure)}` : text, { status: response.status, statusText: response.statusText, headers })
    }
    catch (error) { throw new Error(blockFailureDetails(error), { cause: error }) }
  }, stop: () => helia.stop() }
}
