import { expect, test } from "bun:test"
import { expect as browserExpect } from "playwright/test"
import { CID } from "multiformats/cid"
import { sha256 } from "multiformats/hashes/sha2"
import { launchBrowser, selectedPappBrowser } from "./browsers.ts"
import { frameworkFixture } from "./fixture.ts"
import { bootstrap } from "./scenarios.ts"
import { workerConfig } from "../../applications/papp-gateway/src/config-store.ts"

test("framework cold start, POST, HEAD, GET and decoded media", async () => {
  const { gateway: papp, objects, balance } = await frameworkFixture();
  const bytes = Buffer.from(await Bun.file("testing/papp/fixtures/mountains.png").arrayBuffer())
  const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString()
  try {
    for (const mode of ["kubo", "paid"]) {
      console.log(`pApp smoke: ${selectedPappBrowser()}/${mode}`)
      papp.setMode(mode)
      const browser = await launchBrowser(selectedPappBrowser(), { ca: papp.ca, spki: papp.spki })
      try {
        const page = await browser.context.newPage()
        const errors: string[] = []
        page.on("pageerror", error => errors.push(error.message))
        await bootstrap(papp, page, mode, balance)
        const savedConfig = await page.evaluate(workerConfig)
        expect(savedConfig.server).toBe('https://localhost:3002');
        const result = await page.evaluate(async ({ cid, value, functionality }) => {
          const headers = { "content-type": "application/json", "x-paid-functionality": JSON.stringify(functionality) }
          const stored = await fetch("https://paid.invalid/kvstore.v1.MeteredStorageService/CreateCASValue", {
            method: "POST", headers,
            body: JSON.stringify({ storageBackend: "STORAGE_BACKEND_BLOB_STORAGE", codec: "CODEC_RAW", key: cid, ttl: "2592000s", value }),
          })
          if (!stored.ok) throw new Error(`media upload: ${stored.status} ${await stored.text()}`)
          const url = "https://paid.invalid/applications/user/public/value/" + cid
          const head = await fetch(url, { method: "HEAD", headers })
          const fetched = await fetch(url, { headers })
          if (!fetched.ok) throw new Error(`media download: ${fetched.status} ${await fetched.text()}`)
          const data = new Uint8Array(await fetched.arrayBuffer())
          const blob = URL.createObjectURL(new Blob([data], { type: "image/png" }))
          try {
            const image = new Image(); image.src = blob; await image.decode()
            return { upload: stored.status, head: head.status, headBytes: (await head.arrayBuffer()).byteLength, bytes: btoa(Array.from(data, b => String.fromCharCode(b)).join("")), width: image.naturalWidth, height: image.naturalHeight }
          } finally { URL.revokeObjectURL(blob) }
        }, { cid, value: bytes.toString("base64"), functionality: objects })
        expect(result.upload).toBe(200)
        expect(result.head).toBe(200)
        expect(result.headBytes).toBe(0)
        expect(result.bytes).toBe(bytes.toString("base64"))
        expect(result.width).toBe(800)
        expect(result.height).toBe(534)
        expect(errors).toEqual([])
      } finally { await browser.close() }
    }
  } finally { await papp.close() }
}, 240000)
