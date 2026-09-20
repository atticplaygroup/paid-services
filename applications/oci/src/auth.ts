// Incoming authentication
import type { Context, Next } from "hono"

const USER_ID_HEADER = "x-user-id"

export async function authMiddleware(c: Context, next: Next): Promise<void> {
  const userId = c.req.header(USER_ID_HEADER)
  if (!userId) {
    c.status(401)
    return c.json({ errors: [{ code: "UNAUTHORIZED", message: "missing x-user-id header" }] }) as any
  }
  c.set("userId", userId)
  await next()
}

export function getUserId(c: Context): string {
  return c.get("userId") as string
}
