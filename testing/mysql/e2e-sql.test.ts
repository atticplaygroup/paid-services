import { beforeAll, expect, test } from "bun:test"
import { generateKeyPair, generateProof } from "dpop"
import { execFileSync } from "node:child_process"

const origin = "http://replica-envoy.replica-ns.svc.cluster.local:8080"
let key: CryptoKeyPair
const admin = (sql: string) => execFileSync("mysql", ["-h", "mysql-replica.replica-ns.svc.cluster.local", "-uroot", "--raw", "-N", "-B", "-e", sql], { encoding: "utf8", env: { ...process.env, MYSQL_PWD: "root" } }).trim()
async function auth(path: string, body: object, signal?: AbortSignal) {
  const url = origin + path
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await generateProof(key, url, "POST")}` }, body: JSON.stringify(body), signal })
}
const query = (sql: string, signal?: AbortSignal, parameters?: unknown[]) => auth("/sql", { sql, parameters }, signal)
const balance = async () => { const r = await auth("/account.v1.AccountService/GetBalance", {}); expect(r.status).toBe(200); return BigInt((await r.json()).balance ?? 0) }
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await Bun.sleep(100) }
  throw new Error("condition did not become true")
}
beforeAll(async () => {
  key = await generateKeyPair("ES256", { extractable: true })
  expect((await auth("/account.v1.AccountService/CreditBalance", { amount: "1000000000000" })).status).toBe(200)
  admin("CREATE DATABASE IF NOT EXISTS public_catalog; CREATE TABLE IF NOT EXISTS public_catalog.sql_gateway_test (id BIGINT, amount DECIMAL(30,10), missing TEXT); TRUNCATE public_catalog.sql_gateway_test; INSERT INTO public_catalog.sql_gateway_test VALUES (9007199254740993,12345678901234567890.1234567890,NULL)")
})
const stopped = () => admin("SELECT COUNT(*) FROM information_schema.processlist WHERE USER LIKE 'paid_%'") === "0"

test("paid public SQL reads exact strings and null, denies mutations, and deducts balance", async () => {
  const anonymous = await fetch(origin + "/sql", { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }) })
  expect(anonymous.ok).toBe(false)
  const before = await balance()
  const response = await query("SELECT * FROM public_catalog.sql_gateway_test")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ columns: ["id", "amount", "missing"], rows: [["9007199254740993", "12345678901234567890.1234567890", null]] })
  await eventually(async () => await balance() < before)
  for (const statement of ["DELETE FROM public_catalog.sql_gateway_test", "DROP TABLE public_catalog.sql_gateway_test", "SELECT * FROM mysql.user"]) expect((await query(statement)).status).toBe(400)
  await eventually(stopped)
})

test("completion closes sessions, transactions, and advisory locks", async () => {
  const first = await query("SELECT CONNECTION_ID(), GET_LOCK('paid-e2e-finish',0), @marker := 9")
  expect(first.status).toBe(200)
  const firstRows = (await first.json()).rows
  expect(firstRows[0][1]).toBe("1")
  const second = await query("SELECT CONNECTION_ID(), @marker, IS_FREE_LOCK('paid-e2e-finish')")
  const secondRows = (await second.json()).rows
  expect(secondRows[0][0]).not.toBe(firstRows[0][0])
  expect(secondRows[0][1]).toBeNull()
  expect(secondRows[0][2]).toBe("1")
  expect((await query("START TRANSACTION READ ONLY")).status).toBe(200)
  await eventually(stopped)
})

test("timeout and disconnect terminate work and release locks and transactions", async () => {
  const timeout = await query("SELECT GET_LOCK('paid-e2e-timeout',0), SLEEP(?) FROM public_catalog.sql_gateway_test FOR SHARE", undefined, [60])
  expect(timeout.status).toBe(504)
  await eventually(stopped)
  expect(admin("SELECT IS_FREE_LOCK('paid-e2e-timeout')")).toBe("1")
  admin("SET SESSION innodb_lock_wait_timeout=1; UPDATE public_catalog.sql_gateway_test SET id=id")
  const abort = new AbortController()
  // Attach rejection handling immediately; this request is expected to abort.
  const pending = query("SELECT GET_LOCK('paid-e2e-disconnect',0), SLEEP(60) FROM public_catalog.sql_gateway_test FOR SHARE", abort.signal).then(() => false, () => true)
  await eventually(() => admin("SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id=IS_USED_LOCK('paid-e2e-disconnect')") === "1")
  abort.abort()
  expect(await pending).toBe(true)
  await eventually(stopped)
  expect(admin("SELECT IS_FREE_LOCK('paid-e2e-disconnect')")).toBe("1")
  admin("SET SESSION innodb_lock_wait_timeout=1; UPDATE public_catalog.sql_gateway_test SET id=id")
})


test("SQL errors release acquired advisory locks and row locks", async () => {
  const pending = query("SELECT JSON_EXTRACT(CONCAT(GET_LOCK('paid-e2e-error',0), SLEEP(0.5), 'invalid-json'), '$') FROM public_catalog.sql_gateway_test FOR SHARE")
  await eventually(() => admin("SELECT IS_USED_LOCK('paid-e2e-error')") !== "NULL")
  const response = await pending
  expect(response.status).toBe(400)
  await eventually(stopped)
  expect(admin("SELECT IS_FREE_LOCK('paid-e2e-error')")).toBe("1")
  admin("SET SESSION innodb_lock_wait_timeout=1; UPDATE public_catalog.sql_gateway_test SET id=id")
})


test("binds client parameters without treating their contents as SQL", async () => {
  const value = "x'; DELETE FROM public_catalog.sql_gateway_test; --"
  const response = await query("SELECT ?, ?, ?, ?", undefined, [value, null, true, "12345678901234567890.1234567890"])
  expect(response.status).toBe(200)
  expect((await response.json()).rows).toEqual([[value, null, "1", "12345678901234567890.1234567890"]])
  const selected = await query("SELECT id FROM public_catalog.sql_gateway_test WHERE id=? LIMIT ?", undefined, ["9007199254740993", 1])
  expect(selected.status).toBe(200)
  expect((await selected.json()).rows).toEqual([["9007199254740993"]])
})
