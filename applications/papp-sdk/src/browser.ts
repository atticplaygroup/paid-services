// Optional helpers for applications controlled by the PAID service worker.
// Routing, authentication and payments run in the worker, not in these helpers.
import { budget, rendering, type Functionality } from "./manifest.ts"
export function paidFetch(functionality: Functionality, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("X-PAID-Functionality", JSON.stringify(functionality))
  return fetch(new URL(path, "https://paid.invalid"), { ...init, headers })
}
export async function getDailyBudget() {
  const response = await paidFetch(budget, "/budget")
  if (!response.ok) throw new Error(await response.text())
  return response.json() as Promise<{ dailyBudget: string; spent: string; remaining: string }>
}
export async function navigate(id: string) {
  const response = await paidFetch(rendering, "/render?id=" + encodeURIComponent(id))
  if (!response.ok) throw new Error(await response.text())
  location.assign((await response.json()).url)
}
