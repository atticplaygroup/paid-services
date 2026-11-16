import type { Config, createClient } from "../client.ts"
import { createRemoteJWKSet, jwtVerify } from "jose"
const main = document.querySelector("main")!, status = document.querySelector("#status")!
const text = (v: any) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
let user: any = null
const mediaUrls = new Set<string>()
function message(value: string, error = false) { status.textContent = value; status.className = error ? "error" : "" }
function values(form: HTMLFormElement) { return Object.fromEntries(new FormData(form)) as Record<string,string> }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check: () => Promise<boolean>) {
  message("Waiting for publication and replication…")
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) { try { if (await check()) { message(""); return } } catch {} await delay(1000) }
  throw new Error("Replication did not become visible in time. Refresh to try again.")
}
export async function runFrontend(config: Config, client: ReturnType<typeof createClient>, options: { beforeNavigate?: () => void } = {}) {
  const get = (path: string) => client.api(path)
  const oidcOrigin = config.oidcOrigin ?? config.issuer
  async function session(token: string) {
    await client.setToken(token)
    user = token ? (await client.mutate("/api/session", "POST", {})).user : null
    if (user) localStorage.setItem("realworld.token", token); else localStorage.removeItem("realworld.token")
    document.querySelector("#account")!.textContent = user?.username ?? "Guest"
    ;(document.querySelector("#login") as HTMLButtonElement).hidden = !!user
    ;(document.querySelector("#logout") as HTMLButtonElement).hidden = !user
  }
  function guarded(work: () => Promise<void>) { return () => work().catch(e => message(e.message, true)) }
  document.querySelector("#logout")!.addEventListener("click", guarded(async () => { await session(""); location.hash = "#/"; await render() }))
  document.querySelector("#login")!.addEventListener("click", guarded(async () => {
    const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    const verifier = random(), state = random(), nonce = random()
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
    sessionStorage.setItem("oidc", JSON.stringify({ verifier, state, nonce }))
    const target = new URL(oidcOrigin + "/authorize")
    Object.entries({ client_id: "realworld", response_type: "code", scope: "openid profile email", redirect_uri: config.callback, code_challenge: challenge, code_challenge_method: "S256", state, nonce }).forEach(([k,v]) => target.searchParams.set(k,v))
    options.beforeNavigate?.()
    location.assign(target.href)
  }))
  if (location.pathname === "/callback") {
    const params = new URLSearchParams(location.search), pending = JSON.parse(sessionStorage.getItem("oidc") ?? "null")
    sessionStorage.removeItem("oidc")
    if (!pending || pending.state !== params.get("state")) throw new Error("OIDC state mismatch")
    const response = await fetch(oidcOrigin + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: "realworld", redirect_uri: config.callback, code: params.get("code") ?? "", code_verifier: pending.verifier }) })
    if (!response.ok) throw new Error("OIDC token exchange failed")
    const tokens = await response.json()
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(oidcOrigin + "/jwks")), { issuer: config.issuer, audience: "realworld" })
    if (payload.nonce !== pending.nonce) throw new Error("OIDC nonce mismatch")
    await session(tokens.access_token)
    history.replaceState(null, "", "/#/")
  } else { await session(localStorage.getItem("realworld.token") ?? "") }
  let renderQueue: Promise<void> = Promise.resolve()
  function render() {
    const next = renderQueue.catch(() => {}).then(renderView)
    renderQueue = next
    return next
  }
  async function renderView() {
    mediaUrls.forEach(url => URL.revokeObjectURL(url)); mediaUrls.clear()
    const route = location.hash.slice(1) || "/", [path, search] = route.split("?"), parts = path.split("/"), params = new URLSearchParams(search)
    message("Loading…")
    if (["editor", "settings", "feed"].includes(parts[1]) && !user) { main.innerHTML = "<h1>Log in to continue</h1>"; message(""); return }
    if (parts[1] === "settings") {
      main.innerHTML = `<h1>Your settings</h1><form id="settings"><label>Username<input name="username" value="${text(user.username)}" required></label><label>Bio<textarea aria-label="Bio" name="bio">${text(user.bio)}</textarea></label><label>Image CID or URL<input name="image" value="${text(user.image)}"></label><label>Upload avatar<input name="avatar" type="file" accept="image/*"></label><button>Save settings</button></form>`
      main.querySelector("form")!.onsubmit = event => { event.preventDefault(); guarded(async () => {
        const form = event.currentTarget as HTMLFormElement, input: any = values(form), file = (form.elements.namedItem("avatar") as HTMLInputElement).files?.[0]
        delete input.avatar
        if (file) input.image = "paid:" + await client.upload(new Uint8Array(await file.arrayBuffer()))
        user = (await client.api("/api/user", "PUT", { user: input })).user
        await waitFor(async () => (await get(`/api/profiles/${encodeURIComponent(user.username)}`)).profile.bio === user.bio)
        await session(user.token); message("Settings saved")
      })() }
    } else if (parts[1] === "editor") {
      const a = parts[2] ? (await get("/api/articles/" + parts[2])).article : {}
      main.innerHTML = `<h1>${a.slug ? "Edit article" : "New article"}</h1><form id="editor"><label>Title<input name="title" required value="${text(a.title)}"></label><label>Description<input name="description" required value="${text(a.description)}"></label><label>Body<textarea aria-label="Body" name="body" required>${text(a.body)}</textarea></label><label>Tags<input name="tags" value="${text(a.tagList?.join(", "))}"></label><label>Attach image<input name="attachment" type="file" accept="image/*"></label><button>Publish article</button></form>`
      main.querySelector("form")!.onsubmit = event => { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; guarded(async () => {
        const input: any = values(form), file = (form.elements.namedItem("attachment") as HTMLInputElement).files?.[0]
        if (file) input.body += `\n![attachment](paid:${await client.upload(new Uint8Array(await file.arrayBuffer()))})`
        const article = { title: input.title, description: input.description, body: input.body, ...(!a.slug ? { tagList: input.tags.split(",").map((t: string) => t.trim()).filter(Boolean) } : {}) }
        const saved = (await client.api("/api/articles" + (a.slug ? "/" + a.slug : ""), a.slug ? "PUT" : "POST", { article })).article
        await waitFor(async () => (await get("/api/articles/" + saved.slug)).article.body === saved.body)
        location.hash = "#/article/" + saved.slug
      })() }
    } else if (parts[1] === "article") {
      const slug = parts[2], a = (await get("/api/articles/" + slug)).article, comments = (await get(`/api/articles/${slug}/comments`)).comments
      main.innerHTML = `<article><h1>${text(a.title)}</h1><p>${text(a.description)}</p><a href="#/profile/${encodeURIComponent(a.author.username)}">${text(a.author.username)}</a><p id="article-body" style="white-space:pre-wrap">${text(a.body)}</p><div id="media"></div><p>${a.tagList.map(text).join(" · ")}</p>${user ? `<button id="favorite">${a.favorited ? "Unfavorite" : "Favorite"} (${a.favoritesCount})</button>` : ""}${user?.username === a.author.username ? `<a href="#/editor/${slug}">Edit article</a><button id="delete-article">Delete article</button>` : ""}</article><h2>Comments</h2><section id="comments">${comments.map((c: any) => `<article data-comment="${c.id}"><p>${text(c.body)}</p><small>${text(c.author.username)}</small>${user?.username === c.author.username ? `<button data-delete-comment="${c.id}">Delete comment</button>` : ""}</article>`).join("")}</section>${user ? '<form id="comment"><label>Comment<textarea aria-label="Comment" name="body" required></textarea></label><button>Add comment</button></form>' : ""}`
      main.querySelector("#favorite")?.addEventListener("click", guarded(async () => {
        await client.api(`/api/articles/${slug}/favorite`, a.favorited ? "DELETE" : "POST", a.favorited ? undefined : {})
        await waitFor(async () => (await get(`/api/articles/${slug}`)).article.favorited !== a.favorited); await render()
      }))
      main.querySelector("#delete-article")?.addEventListener("click", guarded(async () => {
        await client.api(`/api/articles/${slug}`, "DELETE")
        await waitFor(async () => { try { await get(`/api/articles/${slug}`); return false } catch (e: any) { return e.status === 404 } }); location.hash = "#/"
      }))
      main.querySelectorAll<HTMLButtonElement>("[data-delete-comment]").forEach(button => button.addEventListener("click", guarded(async () => {
        await client.api(`/api/articles/${slug}/comments/${button.dataset.deleteComment}`, "DELETE")
        await waitFor(async () => !(await get(`/api/articles/${slug}/comments`)).comments.some((c: any) => c.id === Number(button.dataset.deleteComment))); await render()
      })))
      const form = main.querySelector<HTMLFormElement>("#comment")
      if (form) form.onsubmit = event => { event.preventDefault(); guarded(async () => {
        const comment = (await client.api(`/api/articles/${slug}/comments`, "POST", { comment: values(form) })).comment
        await waitFor(async () => (await get(`/api/articles/${slug}/comments`)).comments.some((c: any) => c.id === comment.id)); await render()
      })() }
      for (const match of a.body.matchAll(/!\[[^\]]*\]\(paid:([a-z0-9]+)\)/g)) {
        const blob = await client.media(match[1]); mediaUrls.add(blob)
        const image = document.createElement("img"); image.src = blob; image.alt = "Article attachment"; main.querySelector("#media")!.append(image)
      }
    } else if (parts[1] === "profile") {
      const p = (await get("/api/profiles/" + parts[2])).profile
      main.innerHTML = `<h1>${text(p.username)}</h1><p>${text(p.bio)}</p>${user && user.username !== p.username ? `<button id="follow">${p.following ? "Unfollow" : "Follow"}</button>` : ""}<section id="articles"></section>`
      main.querySelector("#follow")?.addEventListener("click", guarded(async () => {
        await client.api(`/api/profiles/${parts[2]}/follow`, p.following ? "DELETE" : "POST", p.following ? undefined : {})
        await waitFor(async () => (await get(`/api/profiles/${parts[2]}`)).profile.following !== p.following); await render()
      }))
      if (p.image) { const img = document.createElement("img"); img.alt = "Profile avatar"; img.src = p.image.startsWith("paid:") ? await client.media(p.image.slice(5)) : p.image; if (img.src.startsWith("blob:")) mediaUrls.add(img.src); main.prepend(img) }
      await list(new URLSearchParams({ author: p.username }))
    } else {
      main.innerHTML = `<h1>${parts[1] === "feed" ? "Your feed" : "Global feed"}</h1><form id="filter"><label>Tag<input name="tag" value="${text(params.get("tag"))}"></label><button>Filter</button></form><section id="articles"></section><button id="previous">Previous page</button><button id="next">Next page</button>`
      main.querySelector("form")!.onsubmit = event => { event.preventDefault(); location.hash = "#/?" + new URLSearchParams(values(event.currentTarget as HTMLFormElement)) }
      for (const [id, delta] of [["previous", -10], ["next", 10]] as const) main.querySelector("#" + id)!.addEventListener("click", () => { params.set("offset", String(Math.max(0, Number(params.get("offset") ?? 0) + delta))); location.hash = "#" + path + "?" + params })
      params.set("limit", "10"); await list(params, parts[1] === "feed")
    }
    message(""); document.documentElement.dataset.ready = "true"
  }
  async function list(params: URLSearchParams, feed = false) {
    const result = await get(`/api/articles${feed ? "/feed" : ""}?${params}`)
    main.querySelector("#articles")!.innerHTML = result.articles.map((a: any) => `<article><a href="#/article/${a.slug}"><h2>${text(a.title)}</h2></a><p>${text(a.description)}</p><a href="#/profile/${encodeURIComponent(a.author.username)}">${text(a.author.username)}</a><small> · ${a.favoritesCount} favorites</small></article>`).join("") || "<p>No articles yet.</p>"
  }
  window.addEventListener("hashchange", guarded(render))
  window.addEventListener("pageshow", event => { if (event.persisted) guarded(render)() })
  await render()
}
