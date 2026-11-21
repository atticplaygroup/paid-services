import { Database } from "bun:sqlite"
import { createAuthenticatedFetch, type AccessTokenProvider } from "../../client-auth/src/lib.ts"
import { discover, createAverageScoreRanker, type Functionality } from "../../router/src/lib.ts"
import { Cashier, type CashierConfig } from "../../cashier/src/lib.ts"
import { sha256 } from "../../cashier/src/identity.ts"
export interface UserConfig {
  indices: string[]; providerScorings: Functionality[]; dailyBudget: string
  appPercentages?: Record<string, number>; proposerPercentages?: Record<string, number>
}
export interface UserServerOptions {
  database: string; config: UserConfig; wallet?: CashierConfig
  // Fixture-funded identities are injected only by tests, never by browser code.
  tokenProvider?: (profile: string) => Promise<AccessTokenProvider>
  fetch?: typeof fetch; clock?: () => Date
}
export function createUserServer(options: UserServerOptions) {
  const db = new Database(options.database, { create: true })
  db.run("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
  db.run("CREATE TABLE IF NOT EXISTS spending (day TEXT, app TEXT, proposer TEXT, amount TEXT)")
  db.run("CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, app TEXT, proposer TEXT)")
  db.run("INSERT OR IGNORE INTO settings VALUES (1, ?)", [JSON.stringify(options.config)])
  const clock = options.clock ?? (() => new Date())
  const providers = new Map<string, Promise<AccessTokenProvider>>()
  const config = () => JSON.parse((db.query("SELECT value FROM settings WHERE id=1").get() as any).value) as UserConfig
  function budget(app: string, proposer: string) {
    const c = config(), total = BigInt(c.dailyBudget)
    const percentage = Math.min(c.appPercentages?.[app] ?? 100, c.proposerPercentages?.[proposer] ?? 100)
    const daily = total * BigInt(Math.round(percentage * 100)) / 10000n
    const rows = db.query("SELECT app, proposer, amount FROM spending WHERE day=?").all(clock().toISOString().slice(0, 10)) as any[]
    const sum = (filter: (r: any) => boolean) => rows.filter(filter).reduce((n, r) => n + BigInt(r.amount), 0n)
    const spent = sum(r => r.app === app)
    const limits = [total - sum(() => true), daily - spent]
    if (c.proposerPercentages?.[proposer] !== undefined) limits.push(total * BigInt(Math.round(c.proposerPercentages[proposer] * 100)) / 10000n - sum(r => r.proposer === proposer))
    const remaining = limits.reduce((a,b) => a < b ? a : b)
    return { dailyBudget: daily.toString(), spent: spent.toString(), remaining: (remaining > 0n ? remaining : 0n).toString() }
  }
  function recordDeposit(profile: string, amount: bigint) {
    const p = db.query("SELECT * FROM profiles WHERE id=?").get(profile) as any
    if (!p) throw new Error("unknown cashier profile")
    db.run("INSERT INTO spending VALUES (?, ?, ?, ?)", [clock().toISOString().slice(0,10), p.app, p.proposer, amount.toString()])
  }
  function tokenProvider(profile: string) {
    let value = providers.get(profile)
    if (!value) {
      value = (async () => {
        if (options.tokenProvider) return options.tokenProvider(profile)
        const wallet = options.wallet
        if (!wallet) throw new Error("Configure a cashier wallet in the user server")
        const source = wallet.accounts[0], payment = source.payments[0]
        if (!payment) throw new Error("Configure a payment method")
        const masterSecret = sha256(new Uint8Array([...source.masterSecret, ...new TextEncoder().encode(profile)]))
        const cashier = new Cashier({ ...wallet, accounts: [{ ...source, principal: profile, masterSecret }] }, { fetch: options.fetch, onProviderDeposit: event => recordDeposit(profile, event.amount) })
        return { async getAccessToken(request) { return (await cashier.getAccessToken({ htu: request.url, htm: request.method, preferredPaymentCoin: payment.paymentCoin, preferredPaymentEnvironment: payment.paymentEnvironment }, profile)).accessToken } } satisfies AccessTokenProvider
      })()
      providers.set(profile, value)
      value.catch(() => providers.delete(profile))
    }
    return value
  }
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-paid-app,x-paid-proposer,x-paid-profile", "access-control-allow-methods": "GET,POST,PUT,OPTIONS" }
  async function handle(request: Request) {
    try {
      const url = new URL(request.url)
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
      const response = (body: unknown, status = 200) => Response.json(body, { status, headers: cors })
      if (url.pathname === "/healthz") return response({ ok: true })
      if (url.pathname === "/config") {
        if (request.method === "PUT") {
          const c = await request.json() as UserConfig
          if (BigInt(c.dailyBudget) < 0n || !Array.isArray(c.indices) || !Array.isArray(c.providerScorings)) throw new Error("Invalid budget or routing configuration")
          for (const percentage of [...Object.values(c.appPercentages ?? {}), ...Object.values(c.proposerPercentages ?? {})]) if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new Error("Invalid budget percentage")
          db.run("UPDATE settings SET value=? WHERE id=1", [JSON.stringify(c)])
        }
        return response(config())
      }
      if (url.pathname === "/") return new Response(`<!doctype html><title>PAID user server</title><h1>User configuration</h1><p>Routing preferences and daily budgets</p><textarea id="config" rows="20" cols="80"></textarea><button id="save">Save</button><h2>Wallet details</h2><pre id="wallet"></pre><script>fetch('/config').then(r=>r.json()).then(c=>config.value=JSON.stringify(c,null,2));fetch('/wallet').then(r=>r.json()).then(c=>wallet.textContent=JSON.stringify(c,null,2));save.onclick=async()=>{const r=await fetch('/config',{method:'PUT',body:config.value});if(!r.ok)alert(await r.text())}</script>`, { headers: { ...cors, "content-type": "text/html" } })
      if (url.pathname === "/wallet") return response({ configured: !!options.wallet, accounts: options.wallet?.accounts.map(a => ({ principal: a.principal, payments: a.payments.map(p => ({ coin: p.paymentCoin, environment: p.paymentEnvironment })) })) ?? [] })
      const app = request.headers.get("x-paid-app"), proposer = request.headers.get("x-paid-proposer"), profile = request.headers.get("x-paid-profile")
      if (!app || !proposer || !profile) return response({ error: "Missing pApp or worker identity" }, 400)
      db.run("INSERT OR IGNORE INTO profiles VALUES (?, ?, ?)", [profile, app, proposer])
      const existing = db.query("SELECT * FROM profiles WHERE id=?").get(profile) as any
      if (existing.app !== app || existing.proposer !== proposer) throw new Error("cashier profile belongs to another pApp")
      if (url.pathname === "/budget") return response(budget(app, proposer))
      if (budget(app, proposer).remaining === "0") return response({ error: "Daily budget exhausted" }, 402)
      if (url.pathname === "/providers") {
        const body = await request.json() as { functionality: Functionality }
        const c = config()
        const authenticated = createAuthenticatedFetch(await tokenProvider(profile), options.fetch ?? fetch)
        const found = await discover({ indices: c.indices, providerRanker: createAverageScoreRanker(c), fetch: authenticated }, body.functionality)
        return response(found.map(provider => ({ origin: provider.origin, principal: provider.principal })))
      }
      if (url.pathname === "/token") {
        const body = await request.json() as { url: string; method: string }
        return response({ accessToken: await (await tokenProvider(profile)).getAccessToken({ ...body, headers: new Headers() }) })
      }
      if (url.pathname === "/outproxy") {
        const body = await request.json() as { url: string; method: string; headers: [string,string][]; body?: string }
        const target = new URL(body.url)
        if (!["http:", "https:"].includes(target.protocol)) throw new Error("outproxy requires HTTP(S)")
        const upstream = await (options.fetch ?? fetch)(target, { method: body.method, headers: body.headers, body: body.body ? Uint8Array.fromBase64(body.body) : undefined, redirect: "manual", signal: request.signal })
        const headers = new Headers(upstream.headers)
        // Bun already decompresses fetch responses.
        headers.delete("content-encoding"); headers.delete("content-length"); headers.delete("transfer-encoding")
        Object.entries(cors).forEach(([k,v]) => headers.set(k,v))
        return new Response(upstream.body, { status: upstream.status, headers })
      }
      return response({ error: "Not found" }, 404)
    } catch (error) { return Response.json({ error: (error as Error).message }, { status: 502, headers: cors }) }
  }
  return { fetch: handle, budget, recordDeposit, close: () => db.close() }
}
