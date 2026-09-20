import { createHash } from "node:crypto"

/** Compute sha256:hex digest for a byte array. */
export function digestOf(body: Uint8Array): string {
  const hash = createHash("sha256").update(body).digest("hex")
  return `sha256:${hash}`
}
