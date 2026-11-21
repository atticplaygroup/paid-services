/** Runtime wallet configuration belongs to the local frontend's origin. */
export function credentialScript(request: Request, script: string, containsCredentials: boolean): Response {
  const headers = { "content-type": "text/javascript", "cache-control": "no-store", "cross-origin-resource-policy": "same-origin" }
  const site = request.headers.get("sec-fetch-site")
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  if (containsCredentials && (!loopback || (site !== null && site !== "same-origin" && site !== "none"))) {
    return new Response("Local frontend credentials require the same origin", { status: 403, headers })
  }
  return new Response(script, { headers })
}
