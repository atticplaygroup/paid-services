import { Kysely, DummyDriver, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql, type CompiledQuery } from "kysely"

// DummyDriver compiles SQL only. Execution is supplied by either the browser's
// authenticated gateway transport or the proposer's primary connection.
export const db = new Kysely<any>({ dialect: {
  createDriver: () => new DummyDriver(), createAdapter: () => new MysqlAdapter(),
  createIntrospector: d => new MysqlIntrospector(d), createQueryCompiler: () => new MysqlQueryCompiler(),
} }).withSchema("realworld")
export type Execute = (query: CompiledQuery<any>) => Promise<any[]>
export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
export const required = (value: any, name: string) => {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(422, `${name} can't be blank`)
  return value
}
const iso = (v: any) => new Date(typeof v === "string" && !v.endsWith("Z") && !v.includes("T") ? v.replace(" ", "T") + "Z" : v).toISOString()

export function createReads(execute: Execute, viewer = "") {
  const run = (q: any) => execute(q.compile())
  async function profileById(id: string) {
    const [u] = await run(db.selectFrom("users").selectAll().where("id", "=", id))
    if (!u) throw new ApiError(404, "profile not found")
    const following = viewer ? (await run(db.selectFrom("follows").select("follower_id").where("follower_id", "=", viewer).where("followed_id", "=", id))).length > 0 : false
    return { username: u.username, bio: u.bio ?? null, image: u.image ?? null, following }
  }
  async function profile(username: string) {
    const [u] = await run(db.selectFrom("users").select("id").where("username", "=", username))
    if (!u) throw new ApiError(404, "profile not found")
    return { profile: await profileById(u.id) }
  }
  async function articleRow(a: any) {
    const tags = await run(db.selectFrom("article_tags").select("tag").where("article_id", "=", a.id).orderBy("tag"))
    const [count] = await run(db.selectFrom("favorites").select(sql`count(*)`.as("n")).where("article_id", "=", a.id))
    const favorited = viewer ? (await run(db.selectFrom("favorites").select("user_id").where("article_id", "=", a.id).where("user_id", "=", viewer))).length > 0 : false
    return { slug: a.slug, title: a.title, description: a.description, body: a.body, tagList: tags.map(t => t.tag),
      createdAt: iso(a.created_at), updatedAt: iso(a.updated_at), favorited, favoritesCount: Number(count.n), author: await profileById(a.author_id) }
  }
  async function article(slug: string) {
    const [a] = await run(db.selectFrom("articles").selectAll().where("slug", "=", slug))
    if (!a) throw new ApiError(404, "article not found")
    return { article: await articleRow(a) }
  }
  async function articles(params: URLSearchParams, feed = false) {
    if (feed && !viewer) throw new ApiError(401, "login required")
    let query = db.selectFrom("articles as a").selectAll("a")
    if (params.has("tag")) query = query.where("a.id", "in", db.selectFrom("article_tags").select("article_id").where("tag", "=", params.get("tag")))
    if (params.has("author")) query = query.where("a.author_id", "in", db.selectFrom("users").select("id").where("username", "=", params.get("author")))
    if (params.has("favorited")) query = query.where("a.id", "in", db.selectFrom("favorites as f").innerJoin("users as u", "u.id", "f.user_id").select("f.article_id").where("u.username", "=", params.get("favorited")))
    if (feed) query = query.where("a.author_id", "in", db.selectFrom("follows").select("followed_id").where("follower_id", "=", viewer))
    const [count] = await run(query.clearSelect().select(sql`count(*)`.as("n")))
    const number = (name: string, fallback: number, max: number) => {
      if (!params.has(name)) return fallback
      const n = Number(params.get(name)); if (!Number.isInteger(n) || n < 0 || n > max) throw new ApiError(422, `invalid ${name}`)
      return n
    }
    const rows = await run(query.orderBy("a.created_at", "desc").orderBy("a.id", "desc").limit(number("limit", 20, Number.MAX_SAFE_INTEGER)).offset(number("offset", 0, Number.MAX_SAFE_INTEGER)))
    return { articles: await Promise.all(rows.map(articleRow)), articlesCount: Number(count.n) }
  }
  async function comments(slug: string) {
    const [a] = await run(db.selectFrom("articles").select("id").where("slug", "=", slug))
    if (!a) throw new ApiError(404, "article not found")
    const rows = await run(db.selectFrom("comments").selectAll().where("article_id", "=", a.id).orderBy("id", "desc"))
    return { comments: await Promise.all(rows.map(async c => ({ id: Number(c.id), body: c.body, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), author: await profileById(c.author_id) }))) }
  }
  async function get(path: string, params = new URLSearchParams()) {
    if (path === "/api/articles") return articles(params)
    if (path === "/api/articles/feed") return articles(params, true)
    if (path === "/api/tags") return { tags: (await run(db.selectFrom("article_tags").select("tag").distinct().orderBy("tag"))).map(t => t.tag) }
    const segments = path.split("/").map(decodeURIComponent)
    if (segments[2] === "profiles" && segments.length === 4) return profile(segments[3])
    if (segments[2] === "articles" && segments.length === 4) return article(segments[3])
    if (segments[2] === "articles" && segments[4] === "comments" && segments.length === 5) return comments(segments[3])
    throw new ApiError(404, "read API not found")
  }
  return { get, article, profile, comments }
}
