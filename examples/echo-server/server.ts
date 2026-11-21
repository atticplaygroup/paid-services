import { Hono } from "hono"
import { cors } from "hono/cors"

const app = new Hono()
app.use("*", cors({ origin: "*", allowMethods: ["POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }))
app.post("/echo", async c => {
  const body = await c.req.json().catch(() => null)
  const message = body?.message
  if (typeof message !== "string" || message.length > 4096) return c.json({ error: "message must be a string of at most 4096 characters" }, 400)
  return c.json({ message })
})
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch }
