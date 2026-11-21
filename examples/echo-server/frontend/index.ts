import { createRoutedFetch, createAverageScoreRanker, type Functionality } from "../../../applications/router/src/lib.ts"
import { createAuthenticatedFetch } from "../../../applications/client-auth/src/lib.ts"

declare global {
  var PAID_CONFIG: { indices: string[]; providerScorings: Functionality[]; functionality: Functionality }
  // Provisioned by the local launcher, never baked into the publication.
  var PAID_CLIENT_KEY: JsonWebKey | undefined
}

async function start() {
  const jwk = globalThis.PAID_CLIENT_KEY
  if (!jwk) throw new Error("Provision a funded client signing key before launching the app")
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  const key = {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
  }
  const config = globalThis.PAID_CONFIG
  const fetch = createAuthenticatedFetch(key)
  const providerRanker = createAverageScoreRanker({ providerScorings: config.providerScorings })
  const routed = createRoutedFetch({ indices: config.indices, providerRanker, fetch })
  document.querySelector("form")!.addEventListener("submit", async event => {
    event.preventDefault()
    const result = document.querySelector("output")!
    try {
      const response = await routed("https://paid.invalid/echo", {
        functionality: config.functionality,
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: (document.querySelector("input") as HTMLInputElement).value }),
      })
      if (!response.ok) throw new Error(`Echo request failed: ${response.status}`)
      result.textContent = (await response.json()).message
    } catch (error) { result.textContent = String(error) }
  })
  document.documentElement.dataset.ready = "true"
}
start().catch(error => { document.querySelector("output")!.textContent = String(error) })
