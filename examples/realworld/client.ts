import { createPaidClient, verifyProposer, type AccessTokenProvider, type Functionality, type Provider, type ProviderAdvertisement } from "../../applications/papp-sdk/src/lib.ts"
export { verifyProposer, proposerPrincipal as principal } from "../../applications/papp-sdk/src/lib.ts"
import { CID } from "multiformats/cid"
import { create as digest } from "multiformats/hashes/digest"
import { createReads, ApiError } from "./read.ts"
import type { CompiledQuery } from "kysely"

export interface Config {
  indices: string[]; providerScorings: Functionality[]; mutation: Functionality; sql: Functionality; objects: Functionality;
  proposerPrincipal: string; issuer: string; callback: string; oidcOrigin?: string
}
const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
const encode = (b: Uint8Array) => btoa(Array.from(b, x => String.fromCharCode(x)).join(""))
export function createClient(config: Config, key: CryptoKeyPair | AccessTokenProvider, transport: typeof fetch = globalThis.fetch) {
  const { fetch: readFetch, conventionalFetch: mutationFetch } = createPaidClient(config, key, transport)
  let token = "", viewer = ""
  const acceptProvider = (p: Provider, ad: ProviderAdvertisement) => verifyProposer(p, ad, config.proposerPrincipal)
  async function result(response: Response) {
    const text = await response.text()
    let body: any
    try { body = JSON.parse(text) } catch {
      throw new ApiError(response.ok ? 502 : response.status, text || response.statusText)
    }
    if (!response.ok) throw new ApiError(response.status, JSON.stringify(body.errors ?? body))
    return body
  }
  const execute = async (query: CompiledQuery<any>) => {
    const response = await readFetch("https://paid.invalid/sql", { functionality: config.sql, method: "POST", routerRetry: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: query.sql, parameters: query.parameters.map(p => typeof p === "bigint" ? p.toString() : p) }) })
    const value = await result(response)
    return value.rows.map((r: any[]) => Object.fromEntries(value.columns.map((c: string, i: number) => [c, r[i]])))
  }
  async function mutate(path: string, method: string, body?: any) {
    return result(await mutationFetch("https://paid.invalid" + path, { functionality: config.mutation, acceptProvider, routerRetry: false, method, redirect: "error",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }))
  }
  async function api(path: string, method = "GET", body?: any) {
    if (method !== "GET" || path === "/api/user") return mutate(path, method, body)
    const url = new URL(path, "https://paid.invalid")
    return createReads(execute, viewer).get(url.pathname, url.searchParams)
  }
  async function setToken(value: string) {
    token = value
    viewer = value ? JSON.parse(new TextDecoder().decode(bytes(value.split(".")[1]))).sub : ""
  }
  async function upload(value: Uint8Array, ttl = 86400 * 30) {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", value as Uint8Array<ArrayBuffer>))
    const cid = CID.create(1, 0x55, digest(0x12, hash)).toString()
    await result(await readFetch("https://paid.invalid/kvstore.v1.MeteredStorageService/CreateCASValue", { functionality: config.objects, method: "POST", routerRetry: false, headers: { "content-type": "application/json" }, body: JSON.stringify({ storageBackend: "STORAGE_BACKEND_BLOB_STORAGE", codec: "CODEC_RAW", key: cid, ttl: `${ttl}s`, value: encode(value) }) }))
    return cid
  }
  async function media(cid: string, type = "image/png") {
    const value = await result(await readFetch("https://paid.invalid/kvstore.v1.MeteredStorageService/GetCASValue", { functionality: config.objects, method: "POST", routerRetry: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ key: cid }) }))
    const content = bytes(value.value)
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", content))
    if (CID.create(1, 0x55, digest(0x12, hash)).toString() !== cid) throw new Error("media CID mismatch")
    return URL.createObjectURL(new Blob([content], { type }))
  }
  return { api, setToken, upload, media, mutate }
}
