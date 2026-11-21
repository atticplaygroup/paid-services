import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { startKubo } from "./kubo.ts"
import { releaseTag, signReleaseVariant } from "../../applications/papp-sdk/src/variant.ts"
import { X509Certificate, createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { packFiles, publishBlocks } from "../../applications/ipfs/src/pack.ts"
import { createGateway } from "../../applications/papp-gateway/src/server.ts"
import { signManifest, publishManifest } from "../../proposer/app-packer/papp.ts"
import { createUserServer } from "../../applications/user-server/src/lib.ts"
import { DirectAccessTokenProvider, createAuthenticatedFetch } from "../../applications/client-auth/src/lib.ts"
import { pappId, type PappManifest } from "../../applications/papp-sdk/src/lib.ts"
import { keyFromFile, principal, fund, index, storage, advertise, signAdvertisement } from "../routing/helpers.ts"
import type { Page } from "playwright"
export interface GatewayConfig { indices: string[]; providerScorings: any[] }
export interface GatewayOptions {
  name: string;
  files: (base: string) => Promise<Record<string, Uint8Array>>;
  tls?: { cert: string; key: string };
}
export async function setupGateway(config: GatewayConfig, customer: CryptoKeyPair, options: GatewayOptions) {
  const dir = await mkdtemp("/tmp/paid-papp-")
  const certPath = options.tls?.cert ?? dir + "/cert.pem", keyPath = options.tls?.key ?? dir + "/key.pem"
  const ca = dir + "/ca.pem"
  if (!options.tls) {
    await Bun.write(dir + "/server.ext", "subjectAltName=DNS:localhost,DNS:paid.localhost,DNS:*.paid.localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    for (const args of [
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", dir + "/ca-key.pem", "-out", ca, "-days", "2", "-subj", "/CN=PAID fixture CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
      ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", dir + "/server.csr", "-subj", "/CN=paid.localhost"],
      ["x509", "-req", "-in", dir + "/server.csr", "-CA", ca, "-CAkey", dir + "/ca-key.pem", "-CAcreateserial", "-out", certPath, "-days", "2", "-extfile", dir + "/server.ext"],
    ]) {
      const child = Bun.spawn(["openssl", ...args], { stdout: "ignore", stderr: "pipe" })
      const error = await new Response(child.stderr).text()
      if (await child.exited) throw new Error(error)
    }
  }
  const spki = createHash("sha256").update(new X509Certificate(await Bun.file(certPath).text()).publicKey.export({ type: "spki", format: "der" })).digest("base64")
  const tls = { key: Bun.file(keyPath), cert: Bun.file(certPath) }
  const owner = await keyFromFile("pusher"), proposer = await principal(owner)
  const id = await pappId(options.name, proposer)
  const base = `https://${id}.paid.localhost:3003`
  const calls: { url: string; method: string; authorization?: string }[] = []
  let holdBlock: string | undefined
  let blockArrived: (() => void) | undefined
  let releaseBlock: (() => void) | undefined
  let blockGate: Promise<void> | undefined
  let corruptRoot: string | undefined
  const loggedFetch = (async (input, init) => {
    const r = new Request(input, init)
    calls.push({ url: r.url, method: r.method, authorization: r.headers.get("authorization") ?? undefined })
    const path = new URL(r.url).pathname
    const isBlock = (cid: string) => path.endsWith("/user/public/value/" + cid) || path === "/ipfs/" + cid
    if (holdBlock && isBlock(holdBlock)) { blockArrived?.(); await blockGate }
    if (corruptRoot && isBlock(corruptRoot)) return new Response("corrupted block")
    return fetch(r)
  }) as typeof fetch
  const database = dir + "/user.sqlite"
  const userOptions = { database, config: { indices: config.indices, providerScorings: config.providerScorings, dailyBudget: "1000000", appPercentages: { [id]: 50 } }, tokenProvider: async () => new DirectAccessTokenProvider(customer), fetch: loggedFetch }
  let user = createUserServer(userOptions)
  let userOnline = true
  const servers = [Bun.serve({ hostname: "0.0.0.0", port: 3002, tls, fetch: request => userOnline ? user.fetch(request) : new Response("User server unavailable", { status: 503 }) })]
  const files = await options.files(base);
  const packed = await packFiles(files);
  const kubo = await startKubo(packed)
  const paid = createAuthenticatedFetch(customer)
  const ownerPaid = createAuthenticatedFetch(owner)
  await publishBlocks(packed.blocks, storage, paid)
  const releases = new Map<string, PappManifest["functionality"]>()
  async function advertiseRelease(functionality: PappManifest["functionality"]) {
    await advertise(owner, await signAdvertisement(owner, { functionality, providers: [{ origin: storage, principal: proposer, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() }] }))
  }
  async function publish(name: string, version: number) {
    const identity = await pappId(name, proposer)
    const functionality = { behavior: { name: "papp-render", maintainer: proposer, tag: "v1" }, variant: { name: identity, maintainer: proposer, tag: releaseTag() } }
    const manifest = await signManifest(owner, { name, proposer, version, functionality, webpage: `ipfs://${packed.root}` })
    const publication = await publishManifest(manifest, storage, ownerPaid, owner)
    await advertiseRelease(publication.functionality)
    releases.set(name, publication.functionality)
    return manifest
  }
  await fund(owner, index)
  await fund(owner, storage, "1000000000000000")
  await publish(options.name, 1)
  // Build in a fresh process: Bun's in-process resolver can reuse Node-only
  // dependency choices after the IPFS milestone has loaded Helia in this test.
  const sw = Bun.spawn([process.execPath, "build", "applications/papp-gateway/src/sw.ts", "--target", "browser", "--minify", "--outfile", dir + "/sw.js"], { stdout: "ignore", stderr: "pipe" })
  const swError = await new Response(sw.stderr).text()
  if (await sw.exited) throw new Error(`service worker build failed: ${swError}`)
  const gatewayOptions = { gateway: "paid.localhost", worker: await Bun.file(dir + "/sw.js").text(), blockGateway: undefined as string | undefined }
  const app = createGateway(gatewayOptions)
  let bounces = 0
  servers.push(Bun.serve({ hostname: "0.0.0.0", port: 3003, tls, fetch(request) { if (new URL(request.url).hostname.startsWith("config.")) bounces++; return app(request) } }))
  async function configure(page: Page) {
    await page.goto(base);
    await page.getByLabel("User server address").fill("https://localhost:3002");
    await page.getByRole("button", { name: "Save and continue" }).click();
  }
  async function invalidRelease(name: string, transform: (manifest: PappManifest) => PappManifest) {
    const identity = await pappId(name, proposer)
      const functionality = { behavior: { name: "papp-render", maintainer: proposer, tag: "v1" }, variant: { name: identity, maintainer: proposer, tag: releaseTag() } }
      const signed = await signManifest(owner, { name, proposer, version: 1, functionality, webpage: `ipfs://${packed.root}` })
      const bytes = new TextEncoder().encode(JSON.stringify(transform(signed)))
      const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
      await publishBlocks(new Map([[cid, bytes]]), storage, paid)
      const anchor = await signReleaseVariant(owner, functionality, cid)
      const response = await ownerPaid(storage + "/kvstore.v1.MeteredStorageService/CreateProtectedValueAnchor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor }) })
      if (!response.ok) throw new Error(`publish invalid variant: ${response.status}`)
      await advertise(owner, await signAdvertisement(owner, { functionality, providers: [{ origin: storage, principal: proposer, coinType: 1, coinEnvironment: 4, price: 1, updateTime: new Date().toISOString(), expireTime: new Date(Date.now() + 3600000).toISOString() }] }))
      return `https://${identity}.paid.localhost:3003/`
    }
  return {
    base, id, proposer, spki, ca, tls, calls, configure,
    get configurationBounces() { return bounces },
    get user() { return user },
    restartUser() { user.close(); user = createUserServer(userOptions) },
    setUserOnline(online: boolean) { userOnline = online },
    async setDailyBudget(dailyBudget: string) {
      await user.fetch(new Request("http://localhost/config", { method: "PUT", body: JSON.stringify({ ...userOptions.config, dailyBudget }) }));
    },
    publish(version: number) { return publish(options.name, version) },
    publishApp: publish,
    async refreshAdvertisements() { for (const functionality of releases.values()) await advertiseRelease(functionality) },
    invalidRelease,
    setCorruptRoot(corrupt: boolean) { corruptRoot = corrupt ? packed.root.toString() : undefined },
    holdAsset(name: string) {
      const content = new TextDecoder().decode(files[name]);
      holdBlock = [...packed.blocks].find(([, value]) => new TextDecoder().decode(value).startsWith(content))?.[0];
      if (!holdBlock) throw new Error(`packed asset missing: ${name}`);
      const arrived = new Promise<void>(resolve => { blockArrived = resolve });
      blockGate = new Promise<void>(resolve => { releaseBlock = resolve });
      return { arrived, release() { holdBlock = undefined; releaseBlock?.() } };
    },
    setMode(mode: string) { gatewayOptions.blockGateway = mode === "kubo" ? kubo.gateway : undefined },
    async close() { for (const s of servers) s.stop(true); user.close(); await kubo.close(); await rm(dir, { recursive: true, force: true }) },
  }
}
export type GatewayFixture = Awaited<ReturnType<typeof setupGateway>>;
