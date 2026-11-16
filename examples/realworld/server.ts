import mysql from "mysql2/promise"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { createReads, ApiError, required } from "./read.ts"

const issuer = required(process.env.OIDC_ISSUER, "OIDC_ISSUER").replace(/\/$/, "")
const audience = process.env.OIDC_AUDIENCE ?? "realworld"
const backchannel = process.env.OIDC_BACKCHANNEL_URL ?? issuer
const jwks = createRemoteJWKSet(new URL(backchannel + "/jwks"))
const database = process.env.MYSQL_URL ?? "mysql://root:root@localhost:3306/realworld"
const initial = new URL(database); initial.pathname = "/"
const bootstrapDeadline = Date.now() + 120000
let bootstrap: Awaited<ReturnType<typeof mysql.createConnection>>
for (;;) {
  try { bootstrap = await mysql.createConnection({ uri: initial.href, multipleStatements: true }); break }
  catch (error) { if (Date.now() >= bootstrapDeadline) throw error; await Bun.sleep(1000) }
}
await bootstrap.query(await Bun.file(new URL("schema.sql", import.meta.url)).text())
await bootstrap.end()
const pool = mysql.createPool({ uri: database, connectionLimit: 8, dateStrings: true, timezone: "Z", supportBigNumbers: true, bigNumberStrings: true })
const reads = (id = "") => createReads(async q => (await pool.execute(q.sql, [...q.parameters]))[0] as any[], id)
async function query(sql: string, values: any[] = []) { return (await pool.execute(sql, values))[0] as any }
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type" }
function json(body: any, status = 200) { return Response.json(body, { status, headers: cors }) }
async function claims(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^(Bearer|Token) /, "")
  if (!token) throw new ApiError(401, "login required")
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience })
    if (!payload.sub) throw new Error("missing subject")
    return { payload, token }
  } catch { throw new ApiError(401, "invalid token") }
}
async function ensureUser(p: JWTPayload, username?: string) {
  const name = username ?? p.preferred_username
  if (typeof name !== "string" || !name.trim()) throw new ApiError(422, "username is required")
  await query("INSERT INTO users(id,username) VALUES (?,?) ON DUPLICATE KEY UPDATE id=id", [p.sub, name])
  const [u] = await query("SELECT * FROM users WHERE id=?", [p.sub])
  if (!u) throw new ApiError(422, "username is already taken")
  return u
}
async function userResult(p: JWTPayload, token: string) {
  const [u] = await query("SELECT * FROM users WHERE id=?", [p.sub])
  if (!u) throw new ApiError(404, "user not found")
  return { user: { email: p.email, token, username: u.username, bio: u.bio ?? null, image: u.image ?? null } }
}
async function identity(path: string, body: any, token?: string) {
  const response = await fetch(backchannel + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  if (!response.ok) throw new ApiError(response.status, "identity provider rejected request")
  return response.json() as Promise<any>
}
async function ownedArticle(slug: string, owner?: string) {
  const [a] = await query("SELECT * FROM articles WHERE slug=?", [slug])
  if (!a) throw new ApiError(404, "article not found")
  if (owner && a.author_id !== owner) throw new ApiError(403, "not the article owner")
  return a
}
const slugify = (title: string) => `${title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 240) || "article"}-${crypto.randomUUID().slice(0, 8)}`
const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), hostname: "0.0.0.0", async fetch(request) {
  try {
    const url = new URL(request.url), path = url.pathname, method = request.method
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    if (path === "/healthz") return json({ ok: true })
    let body: any = {}
    if (["POST", "PUT"].includes(method)) {
      const raw = await request.text()
      if (raw) { try { body = JSON.parse(raw) } catch { throw new ApiError(422, "invalid JSON") } }
    }
    // RealWorld's password-based API delegates identity operations to the IdP.
    // Browser clients use OIDC authorization code + PKCE and POST /api/session.
    if (method === "POST" && ["/api/users", "/api/users/login"].includes(path)) {
      const input = body.user ?? {}; required(input.email, "email"); required(input.password, "password")
      if (path === "/api/users") required(input.username, "username")
      const result = await identity(path.endsWith("login") ? "/token" : "/register", { ...input, grant_type: "password" })
      const authenticated = await claims(new Request(request.url, { headers: { authorization: `Bearer ${result.access_token}` } }))
      await ensureUser(authenticated.payload, input.username)
      return json(await userResult(authenticated.payload, authenticated.token), path === "/api/users" ? 201 : 200)
    }
    const { payload: p, token } = await claims(request)
    if (path === "/api/session" && method === "POST") { await ensureUser(p); return json(await userResult(p, token)) }
    if (path === "/api/user" && method === "GET") return json(await userResult(p, token))
    if (path === "/api/user" && method === "PUT") {
      const input = body.user ?? {}
      if (input.username !== undefined) required(input.username, "username")
      if (input.email !== undefined || input.password !== undefined) {
        const updated = await identity("/account", input, token)
        if (updated.access_token) return await updateUser(input, await claims(new Request(request.url, { headers: { authorization: `Bearer ${updated.access_token}` } })))
      }
      return await updateUser(input, { payload: p, token })
    }
    const [, , kind, encoded, action, commentId] = path.split("/")
    const value = decodeURIComponent(encoded ?? "")
    if (kind === "profiles" && action === "follow" && ["POST", "DELETE"].includes(method)) {
      const [target] = await query("SELECT id FROM users WHERE username=?", [value])
      if (!target) throw new ApiError(404, "profile not found")
      if (method === "POST") await query("INSERT IGNORE INTO follows VALUES (?,?)", [p.sub, target.id])
      else await query("DELETE FROM follows WHERE follower_id=? AND followed_id=?", [p.sub, target.id])
      return json(await reads(p.sub).profile(value))
    }
    if (path === "/api/articles" && method === "POST") {
      const a = body.article ?? {}; ["title", "description", "body"].forEach(k => required(a[k], k))
      const tags = a.tagList ?? []
      if (!Array.isArray(tags) || tags.some(t => typeof t !== "string" || !t || t.length > 100)) throw new ApiError(422, "invalid tagList")
      const slug = slugify(a.title)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [row]: any = await connection.execute("INSERT INTO articles(slug,title,description,body,author_id) VALUES (?,?,?,?,?)", [slug, a.title, a.description, a.body, p.sub])
        for (const [position, tag] of [...new Set(tags)].entries()) await connection.execute("INSERT INTO article_tags VALUES (?,?,?)", [row.insertId, tag, position])
        await connection.commit()
      } catch (e) { await connection.rollback(); throw e } finally { connection.release() }
      return json(await reads(p.sub).article(slug), 201)
    }
    if (kind === "articles") {
      const a = await ownedArticle(value, !action && ["PUT", "DELETE"].includes(method) ? p.sub : undefined)
      if (!action && method === "PUT") {
        const input = body.article ?? {}, fields = ["title", "description", "body"].filter(k => input[k] !== undefined)
        fields.forEach(k => required(input[k], k))
        let slug = value
        const updates = fields.map(k => `${k}=?`), values = fields.map(k => input[k])
        if (input.title !== undefined) { slug = slugify(input.title); updates.push("slug=?"); values.push(slug) }
        if (updates.length) await query(`UPDATE articles SET ${updates.join(",")},updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [...values, a.id])
        return json(await reads(p.sub).article(slug))
      }
      if (!action && method === "DELETE") { await query("DELETE FROM articles WHERE id=?", [a.id]); return json({}, 200) }
      if (action === "favorite" && ["POST", "DELETE"].includes(method)) {
        if (method === "POST") await query("INSERT IGNORE INTO favorites VALUES (?,?)", [p.sub, a.id])
        else await query("DELETE FROM favorites WHERE user_id=? AND article_id=?", [p.sub, a.id])
        return json(await reads(p.sub).article(value))
      }
      if (action === "comments" && method === "POST") {
        const content = required(body.comment?.body, "body")
        const result = await query("INSERT INTO comments(article_id,author_id,body) VALUES (?,?,?)", [a.id, p.sub, content])
        return json({ comment: (await reads(p.sub).comments(value)).comments.find(c => c.id === Number(result.insertId)) }, 201)
      }
      if (action === "comments" && method === "DELETE" && /^\d+$/.test(commentId ?? "")) {
        const [c] = await query("SELECT * FROM comments WHERE id=? AND article_id=?", [commentId, a.id])
        if (!c) throw new ApiError(404, "comment not found")
        if (c.author_id !== p.sub) throw new ApiError(403, "not the comment owner")
        await query("DELETE FROM comments WHERE id=?", [c.id]); return json({})
      }
    }
    throw new ApiError(404, "mutation API not found")
  } catch (e: any) {
    if (!(e instanceof ApiError) && e.code !== "ER_DUP_ENTRY" && e.code !== "ER_DATA_TOO_LONG") console.error(e)
    return json({ errors: { body: [e instanceof ApiError ? e.message : e.code === "ER_DUP_ENTRY" ? "already taken" : e.code === "ER_DATA_TOO_LONG" ? "value too long" : "internal server error"] } }, e instanceof ApiError ? e.status : ["ER_DUP_ENTRY", "ER_DATA_TOO_LONG"].includes(e.code) ? 422 : 500)
  }
} })
async function updateUser(input: any, auth: { payload: JWTPayload, token: string }) {
  for (const field of ["bio", "image"]) if (input[field] !== undefined && input[field] !== null && typeof input[field] !== "string") throw new ApiError(422, `invalid ${field}`)
  const fields = ["username", "bio", "image"].filter(k => input[k] !== undefined)
  if (fields.length) await query(`UPDATE users SET ${fields.map(k => `${k}=?`).join(",")} WHERE id=?`, [...fields.map(k => input[k]), auth.payload.sub])
  return json(await userResult(auth.payload, auth.token))
}
console.log(`RealWorld mutation API listening on ${server.port}`)
