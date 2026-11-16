import { createPaidClient } from "./client.ts"
export interface WorkerIdentity { app: string; proposer: string; profile: string }
export function userConnection(server: string, identity: WorkerIdentity, network: typeof fetch = fetch) {
  const headers = { "content-type": "application/json", "x-paid-app": identity.app, "x-paid-proposer": identity.proposer, "x-paid-profile": identity.profile }
  async function call(path: string, init: RequestInit = {}, preserveStatus = false) {
    let response: Response
    try { response = await network(new URL(path, server), { redirect: "error", ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init.headers)) } }) }
    catch { throw new Error("User server unavailable. Check its address and connection, then reload.") }
    if (!response.ok && !preserveStatus) throw new Error(`User server: ${response.status} ${await response.text()}`)
    return response
  }
  const outproxy = (async (input, init) => {
    const request = new Request(input, init)
    // Firefox can read body bytes while not exposing Request.body at all.
    const body = ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer())
    return call("/outproxy", { method: "POST", body: JSON.stringify({ url: request.url, method: request.method, headers: [...request.headers], body: body ? btoa(Array.from(body, b => String.fromCharCode(b)).join("")) : undefined }), signal: request.signal }, true)
  }) as typeof fetch
  const credentials = { async getAccessToken(request: { url: string; method: string }) {
    return (await (await call("/token", { method: "POST", body: JSON.stringify({ url: request.url, method: request.method }) })).json()).accessToken
  } }
  // Bootstrap manifest reads need authentication before routing is configured.
  const { authenticatedFetch: authenticated } = createPaidClient({ indices: [], providerScorings: [] }, credentials, outproxy)
  return { call, authenticated, outproxy, async routed() {
    const config = await (await call("/config")).json()
    const { fetch: routed } = createPaidClient(config, credentials, outproxy)
    return (async (input, init) => {
      const request = new Request(input, init), h = request.headers.get("x-paid-functionality")
      if (!h) throw new Error("X-PAID-Functionality is required")
      request.headers.delete("x-paid-functionality")
      const retry = request.headers.get("x-paid-retry"); request.headers.delete("x-paid-retry")
      return routed(request, { functionality: JSON.parse(h), routerRetry: retry === "true" ? true : retry === "false" ? false : undefined })
    }) as typeof fetch
  } }
}
