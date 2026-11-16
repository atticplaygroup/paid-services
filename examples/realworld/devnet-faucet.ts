/** Local development only: the public devnet faucet does not support browser CORS. */
export async function relayDevnetFaucet(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 })
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) return new Response("Invalid origin", { status: 403 })
  let body: any
  try { body = await request.json() } catch { return new Response("Invalid JSON", { status: 400 }) }
  const recipient = body?.FixedAmountRequest?.recipient
  if (typeof recipient !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(recipient)) return new Response("Invalid recipient", { status: 400 })
  const response = await fetch("https://faucet.devnet.sui.io/v2/gas", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ FixedAmountRequest: { recipient } }), signal: AbortSignal.timeout(30000),
  })
  return new Response(response.body, { status: response.status, headers: {
    "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store",
  } })
}
