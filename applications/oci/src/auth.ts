// Incoming authentication
import type { Context, Next } from "hono"

const USER_ID_HEADER = "x-user-id"
const REQUEST_ID_HEADER = "x-request-id"
const EXTERNAL_REQUEST_ID_HEADER = "x-external-request-id"

export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.req.header(USER_ID_HEADER)
  if (!userId) {
    c.status(401)
    return c.json({ errors: [{ code: "UNAUTHORIZED", message: "missing x-user-id header" }] }) as any
  }
  c.set("userId", userId)
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const requestId = c.req.header(REQUEST_ID_HEADER)
    if (!requestId) {
      c.status(400)
      return c.json({ errors: [{ code: "INVALID_ARGUMENT", message: "missing x-request-id header" }] }) as any
    }
    c.set("requestId", requestId)
    const externalRequestId = c.req.header(EXTERNAL_REQUEST_ID_HEADER)
    if (externalRequestId) c.set("externalRequestId", externalRequestId)
  }
  await next()
}

export function getUserId(c: Context): string {
  return c.get("userId") as string
}

export function getRequestId(c: Context): string {
  return (c.get("requestId") as string | undefined) ?? ""
}

export function getExternalRequestId(c: Context): string | undefined {
  return c.get("externalRequestId") as string | undefined
}

export function getRequestIdentity(c: Context): { requestId?: string; externalRequestId?: string } {
  const identity: { requestId?: string; externalRequestId?: string } = {}
  const requestId = c.req.header(REQUEST_ID_HEADER)
  const externalRequestId = c.req.header(EXTERNAL_REQUEST_ID_HEADER)
  if (requestId) identity.requestId = requestId
  if (externalRequestId) identity.externalRequestId = externalRequestId
  return identity
}
