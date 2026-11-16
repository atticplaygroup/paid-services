import { mkdtemp, rm } from "node:fs/promises"
import { carBytes } from "../../applications/ipfs/src/pack.ts"
import type { CID } from "multiformats/cid"
export async function startKubo(packed: { root: CID; blocks: Map<string, Uint8Array> }) {
  const dir = await mkdtemp("/tmp/paid-kubo-")
  const env = { ...process.env, IPFS_PATH: dir }
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["ipfs", ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
    if (code) throw new Error(`ipfs ${args[0]}: ${err}`)
    return out
  }
  await run("init", "--profile=test")
  await run("config", "Addresses.API", "/ip4/127.0.0.1/tcp/15001")
  await run("config", "Addresses.Gateway", "/ip4/127.0.0.1/tcp/18089")
  await run("bootstrap", "rm", "--all")
  const daemon = Bun.spawn(["ipfs", "daemon", "--offline"], { env, stdout: "ignore", stderr: "inherit" })
  try {
    let ready = false
    for (let i=0; i<100; i++) { if (await fetch("http://127.0.0.1:15001/api/v0/id", { method: "POST" }).then(r=>r.ok).catch(()=>false)) { ready = true; break }; await Bun.sleep(100) }
    if (!ready) throw new Error("Kubo daemon did not start")
    await Bun.write(dir + "/app.car", await carBytes(packed.root, packed.blocks))
    await run("dag", "import", dir + "/app.car")
  } catch (error) { daemon.kill(); await daemon.exited; await rm(dir,{recursive:true,force:true}); throw error }
  return { gateway: "http://127.0.0.1:18089", async close() { daemon.kill(); await daemon.exited; await rm(dir, { recursive: true, force: true }) } }
}
