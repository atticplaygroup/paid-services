import { expect } from "bun:test"

/** Exercise the gateway policy with ordinary unauthenticated browser preflights. */
export async function checkGatewayCORS(url: string, allowedOrigins: string[], deniedOrigins: string[] = []) {
  for (const origin of allowedOrigins) {
    const response = await fetch(url, { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,connect-protocol-version,grpc-timeout,x-grpc-web,x-user-agent",
    } })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(origin)
    const headers = response.headers.get("access-control-allow-headers")!.split(",").map(h => h.trim().toLowerCase())
    for (const header of ["authorization", "content-type", "connect-protocol-version", "grpc-timeout", "x-grpc-web", "x-user-agent"]) expect(headers).toContain(header)
    expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    await response.text()
    // The CORS filter must not exempt the actual RPC from PAID authentication.
    const actual = await fetch(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" })
    expect(actual.status).toBe(403)
    expect(actual.headers.get("access-control-allow-origin")).toBe(origin)
    await actual.text()
  }
  for (const origin of deniedOrigins) {
    const response = await fetch(url, { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type",
    } })
    expect(response.status).toBe(403)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    await response.text()
  }
}
