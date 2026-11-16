import { CID } from "multiformats/cid"
export interface GatewayOptions { gateway: string; worker: string; objects?: unknown; blockGateway?: string; delegatedRoutingUrl?: string }
export function createGateway(options: GatewayOptions) {
  return async (request: Request) => {
    const url = new URL(request.url), host = url.hostname
    try {
      if (url.pathname === "/healthz") return Response.json({ ok: true })
      // Deployment transport settings must not survive in a browser profile.
      if (url.pathname === "/__papp/gateway-config") return Response.json({ objects: options.objects ?? null, blockGateway: options.blockGateway ?? null, delegatedRoutingUrl: options.delegatedRoutingUrl ?? null }, { headers: { "cache-control": "no-store" } })
      if (url.pathname === "/bootstrap.js") return new Response(bootstrapScript(options.gateway, options.objects, options.blockGateway, options.delegatedRoutingUrl), { headers: { "content-type": "text/javascript" } })
      if (url.pathname === "/sw.js") return new Response(options.worker, { headers: { "content-type": "text/javascript", "service-worker-allowed": "/", "cache-control": "no-cache" } })
      if (host === `config.${options.gateway}`) return new Response(configPage(options.gateway), { headers: { "content-type": "text/html" } })
      if (url.pathname === "/redirect") {
        const id = CID.parse(url.searchParams.get("id") ?? "").toString()
        const target = new URL(url); target.hostname = id + "." + options.gateway; target.pathname = "/"; target.search = ""
        return Response.redirect(target, 303)
      }
      if (host === options.gateway) return new Response('<!doctype html><title>PAID pApps</title><h1>Open a pApp</h1><form action="/redirect"><label>pApp ID<input name="id" required></label><button>Open</button></form>', { headers: { "content-type": "text/html" } })
      return new Response(`<!doctype html><title>Loading PAID pApp</title><p id="status">Connecting to your user server…</p><script src="/bootstrap.js"></script>`, { headers: { "content-type": "text/html", "cache-control": "no-store" } })
    } catch (error) { return new Response((error as Error).message, { status: 400 }) }
  }
}
export function configPage(gateway: string) { return `<!doctype html><title>PAID configuration</title><h1>PAID configuration</h1><form><label>User server address<input id="server" type="url" required></label><button>Save and continue</button></form><h2>Seen pApps</h2><pre id="seen"></pre><script>
const target=new URL(new URL(location.href).searchParams.get('return')||location.origin);
const allowed=target.hostname.endsWith('.'+${JSON.stringify(gateway)})&&target.hostname!==location.hostname&&target.protocol===location.protocol;
const apps=JSON.parse(localStorage.getItem('apps')||'[]');if(allowed&&!apps.includes(target.hostname)){apps.push(target.hostname);localStorage.setItem('apps',JSON.stringify(apps))}seen.textContent=apps.join('\\n');
function go(value){if(!allowed)return;target.searchParams.set('__paid_config',JSON.stringify({server:value}));location.replace(target)}
server.value=localStorage.getItem('server')||'';if(server.value&&allowed)go(server.value);
document.querySelector('form').onsubmit=e=>{e.preventDefault();localStorage.setItem('server',server.value);go(server.value)};
</script>` }
export function bootstrapScript(gateway: string, objects?: unknown, blockGateway?: string, delegatedRoutingUrl?: string) { return `(async()=>{try{
await navigator.serviceWorker.register('/sw.js',{scope:'/'});await navigator.serviceWorker.ready;
if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));
const u=new URL(location.href),raw=u.searchParams.get('__paid_config');
if(raw){const c=JSON.parse(raw);c.objects=${JSON.stringify(objects ?? null)};c.blockGateway=${JSON.stringify(blockGateway ?? null)};c.delegatedRoutingUrl=${JSON.stringify(delegatedRoutingUrl ?? null)};const r=await fetch('/__papp/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(c)});if(!r.ok)throw new Error(await r.text());u.searchParams.delete('__paid_config');history.replaceState(null,'',u);location.reload();return}
const configured=await fetch('/__papp/config');if(configured.ok){location.reload();return}const cfg=new URL(location.href);cfg.hostname='config.'+${JSON.stringify(gateway)};cfg.pathname='/';cfg.search='';cfg.searchParams.set('return',location.href);location.replace(cfg);
}catch(e){document.querySelector('#status').textContent=e.message;return}
})()` }
if (import.meta.main) {
  const built = await Bun.build({ entrypoints: [new URL("sw.ts", import.meta.url).pathname], target: "browser", minify: true })
  if (!built.success) throw new AggregateError(built.logs, "worker build failed")
  const gateway = process.env.PAPP_GATEWAY ?? "paid.localhost"
  const app = createGateway({ gateway, worker: await built.outputs[0].text(), objects: process.env.PAPP_OBJECTS ? JSON.parse(process.env.PAPP_OBJECTS) : undefined, delegatedRoutingUrl: process.env.PAPP_DELEGATED_ROUTING_URL })
  Bun.serve({ port: Number(process.env.PORT ?? 3003), hostname: "0.0.0.0", ...(process.env.TLS_CERT && process.env.TLS_KEY ? { tls: { cert: Bun.file(process.env.TLS_CERT), key: Bun.file(process.env.TLS_KEY) } } : {}), fetch: app })
}
