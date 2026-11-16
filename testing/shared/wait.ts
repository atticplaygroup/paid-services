const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
export async function until(check: () => Promise<boolean>, label: string, timeout = 180000) {
  const deadline = Date.now() + timeout; let last: any
  while (Date.now() < deadline) {
    try { if (await check()) return } catch (error) { last = error }
    await pause(1000)
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message ?? "condition stayed false"}`)
}
