import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { generateKeyPair } from "dpop"
import { CID } from "multiformats/cid"
import { create } from "multiformats/hashes/digest"

async function run(command: string[]) {
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" })
  if (await process.exited !== 0) throw new Error(`${command[0]} failed`)
}

async function setup(directory: string, providerUrl: string) {
  const providerHostname = new URL(providerUrl).hostname
  await mkdir(directory, { recursive: true })
  await run([
    "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", `${directory}/ca.key`, "-out", `${directory}/ca.crt`, "-days", "1",
    "-subj", "/CN=outproxy-demo-ca", "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign",
  ])
  await run([
    "openssl", "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
    "-keyout", `${directory}/tls.key`, "-out", `${directory}/tls.csr`,
    "-subj", `/CN=${providerHostname}`,
  ])
  await Bun.write(`${directory}/tls.ext`, `extendedKeyUsage=serverAuth\nsubjectAltName=DNS:${providerHostname}\n`)
  await run([
    "openssl", "x509", "-req", "-in", `${directory}/tls.csr`,
    "-CA", `${directory}/ca.crt`, "-CAkey", `${directory}/ca.key`, "-CAcreateserial",
    "-out", `${directory}/tls.crt`, "-days", "1", "-extfile", `${directory}/tls.ext`,
  ])

  const keypair = await generateKeyPair("ES256", { extractable: true })
  const privateJwk = await crypto.subtle.exportKey("jwk", keypair.privateKey)
  const canonicalPublicJwk = JSON.stringify({
    crv: privateJwk.crv,
    kty: privateJwk.kty,
    x: privateJwk.x,
    y: privateJwk.y,
  })
  const digest = create(0x12, new Uint8Array(createHash("sha256").update(canonicalPublicJwk).digest()))
  const principal = CID.create(1, 0xeb51, digest).toString()
  await Promise.all([
    Bun.write(`${directory}/dpop_private_key.json`, JSON.stringify(privateJwk)),
    Bun.write(`${directory}/principal`, principal),
  ])
  console.log(`Demo files created in ${directory}`)
}

async function faucet(directory: string, providerUrl: string, proxyUrl: string) {
  const principal = (await Bun.file(`${directory}/principal`).text()).trim()
  const ca = await Bun.file(`${directory}/ca.crt`).text()
  const url = `${providerUrl}/account.v1.AccountService/CreditBalance`
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 1_000_000_000 }),
        proxy: proxyUrl,
        tls: { ca },
      })
      if (!response.ok) throw new Error(`faucet returned ${response.status}: ${await response.text()}`)
      console.log(`Credited ${principal}`)
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(200)
    }
  }
  throw lastError
}

const [command, directoryArgument, providerUrl, proxyUrl] = Bun.argv.slice(2)
if (!directoryArgument || (command !== "setup" && command !== "faucet")) {
  throw new Error("usage: https-quickstart.ts setup <directory> <provider-url> | faucet <directory> <provider-url> <proxy-url>")
}
if (!providerUrl) throw new Error(`${command} requires <provider-url>`)
const directory = resolve(directoryArgument)
if (command === "setup") await setup(directory, providerUrl)
else {
  if (!proxyUrl) throw new Error("faucet requires <proxy-url>")
  await faucet(directory, providerUrl, proxyUrl)
}
