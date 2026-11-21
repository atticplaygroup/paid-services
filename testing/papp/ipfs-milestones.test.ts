import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { packFiles, carBytes } from "../../applications/ipfs/src/pack.ts"
import { createPaidVerifiedFetch } from "../../applications/ipfs/src/lib.ts"

test("local Kubo serves the packed UnixFS application through verified fetch", async () => {
  const dir = await mkdtemp("/tmp/paid-kubo-")
  const env = { ...process.env, IPFS_PATH: dir }
  let daemon: ReturnType<typeof Bun.spawn> | undefined
  const run = async (...args: string[]) => {
    const p = Bun.spawn(["ipfs", ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
    if (code) throw new Error(`ipfs ${args[0]}: ${err}`)
    return out
  }
  try {
    await run("init", "--profile=test")
    await run("config", "Addresses.API", "/ip4/127.0.0.1/tcp/15001")
    await run("config", "Addresses.Gateway", "/ip4/127.0.0.1/tcp/18089")
    await run("bootstrap", "rm", "--all")
    daemon = Bun.spawn(["ipfs", "daemon", "--offline"], { env, stdout: "ignore", stderr: "inherit" })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (await fetch("http://127.0.0.1:15001/api/v0/id", { method: "POST" }).then(r => r.ok).catch(() => false)) { ready = true; break }
      await Bun.sleep(100)
    }
    expect(ready).toBe(true)
    const packed = await packFiles({ "index.html": new TextEncoder().encode("<!doctype html><h1>Framework IPFS milestone</h1>"), "nested/data.txt": new TextEncoder().encode("verified IPLD") })
    await Bun.write(dir + "/app.car", await carBytes(packed.root, packed.blocks))
    await run("dag", "import", dir + "/app.car")
    const ipfs = await createPaidVerifiedFetch({ objects: {} as any, fetch: (async input => {
      const id = new URL(String(input)).pathname.split("/").pop()
      return fetch(`http://127.0.0.1:18089/ipfs/${id}?format=raw`)
    }) as typeof fetch })
    try {
      expect(await (await ipfs.fetch(`ipfs://${packed.root}/index.html`)).text()).toContain("Framework IPFS milestone")
      expect(await (await ipfs.fetch(`ipfs://${packed.root}/nested/data.txt`)).text()).toBe("verified IPLD")
    } finally { await ipfs.stop() }
  } finally { daemon?.kill(); if (daemon) await daemon.exited; await rm(dir, { recursive: true, force: true }) }
}, 60000)
