// Fixture IdP only: credentials stay here, outside the published application DB.
import { importJWK, exportJWK, SignJWT, jwtVerify, type JWTPayload } from "jose"
const privateJwk = await Bun.file(process.env.OIDC_KEY_FILE ?? "/etc/dpop-keys/pusher.json").json()
const key = await importJWK(privateJwk, "ES256")
const { d: _private, ...publicJwk } = privateJwk
const verificationKey = await importJWK(publicJwk, "ES256")
const issuer = process.env.OIDC_ISSUER ?? "http://localhost:4000"
const audience = "realworld"
const callbacks: string[] = process.env.OIDC_CALLBACKS ? JSON.parse(process.env.OIDC_CALLBACKS) : [process.env.OIDC_CALLBACK ?? "http://localhost:3001/callback"]
type User = { sub: string, email: string, username: string, password: string }
const users = new Map<string, User>()
const codes = new Map<string, { user: User, challenge: string, redirect: string, nonce: string, expires: number }>()
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" }
async function token(user: User, nonce?: string) {
  const value = await new SignJWT({ email: user.email, preferred_username: user.username, ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: "ES256", kid: "fixture" }).setIssuer(issuer).setAudience(audience).setSubject(user.sub).setIssuedAt().setExpirationTime("1h").sign(key)
  return { access_token: value, id_token: value, token_type: "Bearer", expires_in: 3600 }
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
async function account(email: string, password: string, username?: string) {
  if (!email || !password) throw new Error("email and password required")
  if (username) {
    if (users.has(email)) throw new Error("email taken")
    const user = { sub: crypto.randomUUID(), email, username, password: await Bun.password.hash(password) }
    users.set(email, user); return user
  }
  const user = users.get(email)
  if (!user || !await Bun.password.verify(password, user.password)) throw new Error("invalid credentials")
  return user
}
Bun.serve({ port: Number(process.env.PORT ?? 4000), hostname: "0.0.0.0", async fetch(request) {
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    const url = new URL(request.url)
    const respond = (value: any) => Response.json(value, { headers: cors })
    if (url.pathname === "/healthz") return respond({ ok: true })
    if (url.pathname === "/jwks") return respond({ keys: [{ ...publicJwk, kid: "fixture", use: "sig", alg: "ES256" }] })
    if (url.pathname === "/.well-known/openid-configuration") return respond({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks", userinfo_endpoint: issuer + "/userinfo", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] })
    if (url.pathname === "/authorize") {
      const p = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams
      const callback = p.get("redirect_uri") ?? ""
      if (!callbacks.includes(callback) || p.get("client_id") !== audience || p.get("response_type") !== "code" || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) throw new Error("invalid authorization request")
      if (request.method === "GET") return new Response(`<!doctype html><title>Fixture OIDC login</title><h1>Log in or register</h1><form method="post">${[...p].map(([k,v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`).join("")}<label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label><label>Username (registration)<input name="username"></label><button name="mode" value="login">Log in</button><button name="mode" value="register">Register</button></form>`, { headers: { "content-type": "text/html" } })
      const user = await account(p.get("email") ?? "", p.get("password") ?? "", p.get("mode") === "register" ? p.get("username") ?? undefined : undefined)
      const code = crypto.randomUUID()
      codes.set(code, { user, challenge: p.get("code_challenge")!, redirect: callback, nonce: p.get("nonce") ?? "", expires: Date.now() + 60000 })
      const target = new URL(callback); target.searchParams.set("code", code); target.searchParams.set("state", p.get("state") ?? "")
      return Response.redirect(target.href, 303)
    }
    const body = request.method === "POST" ? request.headers.get("content-type")?.includes("application/json") ? await request.json() as any : Object.fromEntries(new URLSearchParams(await request.text())) : {}
    if (url.pathname === "/register") return respond(await token(await account(body.email, body.password, body.username)))
    if (url.pathname === "/token") {
      if (body.grant_type === "authorization_code") {
        const code = codes.get(body.code); codes.delete(body.code)
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier ?? ""))).toString("base64url")
        if (!code || code.expires < Date.now() || code.challenge !== digest || body.redirect_uri !== code.redirect || body.client_id !== audience) throw new Error("invalid code or verifier")
        return respond(await token(code.user, code.nonce))
      }
      if (body.grant_type !== "password") throw new Error("unsupported grant")
      return respond(await token(await account(body.email, body.password)))
    }
    if (["/account", "/userinfo"].includes(url.pathname)) {
      const raw = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
      const { payload } = await jwtVerify(raw, verificationKey, { issuer, audience })
      const user = [...users.values()].find(u => u.sub === payload.sub)
      if (!user) throw new Error("unknown user")
      if (url.pathname === "/userinfo") return respond({ sub: user.sub, email: user.email, preferred_username: user.username })
      if (body.email && body.email !== user.email) { if (users.has(body.email)) throw new Error("email taken"); users.delete(user.email); user.email = body.email; users.set(user.email, user) }
      if (body.password) user.password = await Bun.password.hash(body.password)
      if (body.username) user.username = body.username
      return respond(await token(user))
    }
    return new Response("not found", { status: 404, headers: cors })
  } catch (e: any) { return Response.json({ error: e.message }, { status: 422, headers: cors }) }
} })
