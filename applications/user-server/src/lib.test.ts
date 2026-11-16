import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createUserServer } from "./lib.ts"
test("deposit accounting, percentage limits, UTC rollover, profiles and restart", async () => {
  const directory = mkdtempSync(tmpdir() + "/paid-user-test-")
  let now = new Date("2026-10-31T12:00:00Z")
  const options = { database: directory + "/state.sqlite", config: { indices: [], providerScorings: [], dailyBudget: "1000", appPercentages: { app: 40 }, proposerPercentages: { proposer: 50 } }, clock: () => now, tokenProvider: async () => ({ getAccessToken: async () => "proof" }) }
  let server = createUserServer(options)
  const request = (profile: string, app = "app") => new Request("http://localhost/token", { method: "POST", headers: { "x-paid-app": app, "x-paid-proposer": "proposer", "x-paid-profile": profile }, body: JSON.stringify({ url: "https://provider.test/sql", method: "POST" }) })
  try {
    expect((await server.fetch(request("worker-1"))).status).toBe(200)
    server.recordDeposit("worker-1", 300n)
    expect(server.budget("app", "proposer")).toEqual({ dailyBudget: "400", spent: "300", remaining: "100" })
    expect((await server.fetch(request("worker-2", "other"))).status).toBe(200)
    server.recordDeposit("worker-2", 200n)
    expect(server.budget("app", "proposer").remaining).toBe("0")
    expect((await server.fetch(request("worker-1"))).status).toBe(402)
    server.close(); server = createUserServer(options)
    expect(server.budget("app", "proposer").remaining).toBe("0")
    now = new Date("2026-11-01T00:00:00Z")
    expect(server.budget("app", "proposer").remaining).toBe("400")
    expect((await server.fetch(request("worker-1", "forged"))).status).toBe(502)
  } finally { server.close(); rmSync(directory, { recursive: true, force: true }) }
})
