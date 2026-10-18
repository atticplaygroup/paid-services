import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PROPOSER_HOST = process.env.MYSQL_PROPOSER_HOST ?? "mysql-proposer.proposer-ns.svc.cluster.local"
const REPLICA_HOST = process.env.MYSQL_REPLICA_HOST ?? "mysql-replica.replica-ns.svc.cluster.local"
const OCI_ADDRESS = process.env.OCI_ADDRESS ?? "registry.registry-system.svc.cluster.local:5000"
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD ?? "root"
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let baselineTag: string
let deltaTag: string
let deltaGtidEnd: string
const EXPORTED_SCHEMAS = "user_profile,public_catalog"
const PUBLICATION_STATE = mkdtempSync(join(tmpdir(), "mysql-publications-"))
afterAll(() => rmSync(PUBLICATION_STATE, { recursive: true, force: true }))
const SENSITIVE_SECRET = "private-credential-must-not-leave-source-7ac23"

function command(program: string, args: string[] = [], env: Record<string, string> = {}) {
  return execFileSync(program, args, {
    encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env },
  })
}
function databaseEnv(side: "proposer" | "replica") {
  return {
    MYSQL_HOST: side === "proposer" ? PROPOSER_HOST : REPLICA_HOST,
    MYSQL_PORT: "3306", MYSQL_USER: "root", MYSQL_PASSWORD, MYSQL_PWD: MYSQL_PASSWORD,
    MYSQL_EXPORT_SCHEMAS: EXPORTED_SCHEMAS,
  }
}
function gtids(value: string) { return value.replace(/\s/g, "") }
function artifactDigest(repo: string, tag: string) {
  return command("oras", ["resolve", "--plain-http", `${OCI_ADDRESS}/${repo}:${tag}`]).trim()
}
function sql(side: "proposer" | "replica", query: string) {
  const env = databaseEnv(side)
  return command("mysql", ["-h", env.MYSQL_HOST, "-uroot", "--raw", "-N", "-B", "-e", query], env).trim()
}
function publish(mode = "baseline") {
  const directory = mkdtempSync(join(tmpdir(), "mysql-publish-"))
  try {
    const logs = command("publish.sh", [], {
      ...databaseEnv("proposer"), PUBLISH_MODE: mode, OCI_ADDRESS, BASELINE_REPO: "baseline_app", DELTA_REPO: "binlog_app",
      MANIFEST_REPO: "app-manifests", APPLICATION: "medium", OWNER: "test-proposer", OUTPUT_DIR: directory, PUBLISH_STATE_DIR: PUBLICATION_STATE,
    })
    const tags = logs.match(/publish complete: baseline=(\d+) delta=(\d+) manifest=(\d+)/)
    if (!tags) {
      if (logs.includes("manifest pending:")) return { baseline: "", delta: "", manifest: "", deltaGtidEnd: "" }
      throw new Error(`Publish did not report artifact tags:\n${logs}`)
    }
    command("oras", ["pull", "--plain-http", `${OCI_ADDRESS}/app-manifests:${tags[3]}`, "-o", directory])
    const manifest = Bun.YAML.parse(readFileSync(join(directory, "application-manifest.yaml"), "utf8")) as { databases: { delta: { gtid_end: string } }[] }
    return { baseline: tags[1], delta: tags[2], manifest: tags[3], deltaGtidEnd: manifest.databases[0].delta.gtid_end }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
function importArtifacts(baseline: string, delta = "", gtidEnd = "") {
  const directory = mkdtempSync(join(tmpdir(), "mysql-import-"))
  try {
    return command("/usr/local/bin/import.sh", [], {
      ...databaseEnv("replica"), OCI_ADDRESS, BASELINE_REPO: "baseline_app", BASELINE_TAG: baseline,
      DELTA_REPO: "binlog_app", DELTA_TAG: delta, DELTA_GTID_END: gtidEnd, OUTPUT_DIR: directory,
    })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
async function schedule(namespace: string, name: string, suspend: boolean) {
  const token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim()
  const url = `https://kubernetes.default.svc/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`
  const response = await fetch(url, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({ spec: { suspend, schedule: "* * * * *", concurrencyPolicy: "Forbid" } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Schedule ${name}: ${response.status} ${await response.text()}`)
  if (suspend) {
    // Suspending stops new Jobs; wait for any already-running publisher/importer.
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const status = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      })
      if (!status.ok) throw new Error(`Read ${name}: ${status.status}`)
      const cronjob = await status.json() as { status?: { active?: unknown[] } }
      if (!cronjob.status?.active?.length) return
      await sleep(2000)
    }
    throw new Error(`CronJob ${name} still has active Jobs`)
  }
}
async function schedulePublisher(mode: "baseline" | "delta", suspend: boolean) {
  const cm = JSON.parse(command("kubectl", ["-n", "proposer-ns", "get", "configmap", "mysql-proposer-publisher", "-o", "json"]))
  const lines = cm.data.crontab.trim().split("\n").filter((line: string) => line && !line.includes(`PUBLISH_MODE=${mode} `))
  if (!suspend) lines.push(`* * * * * PUBLISH_MODE=${mode} /usr/local/bin/publish.sh`)
  const crontab = lines.join("\n") + "\n"
  command("kubectl", ["-n", "proposer-ns", "patch", "configmap", "mysql-proposer-publisher", "--type=merge", "-p", JSON.stringify({ data: { crontab } })])
  command("kubectl", ["-n", "proposer-ns", "annotate", "pod", "mysql-proposer-0", `publisher-schedule-refresh=${Date.now()}`, "--overwrite"])
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const mounted = command("kubectl", ["-n", "proposer-ns", "exec", "mysql-proposer-0", "-c", "publisher", "--", "cat", "/etc/mysql-publisher/crontab"])
    if (mounted === crontab) {
      // Reload drains running publications before accepting the changed schedule.
      await sleep(2000)
      const active = command("kubectl", ["-n", "proposer-ns", "exec", "mysql-proposer-0", "-c", "publisher", "--", "sh", "-c", "find /var/lib/mysql/publication-work -mindepth 1 -maxdepth 1 -type d 2>/dev/null || true"])
      if (!suspend || !active.trim()) return
    }
    await sleep(2000)
  }
  throw new Error(`Publisher ${mode} schedule did not settle`)
}
function rows(side: "proposer" | "replica") {
  return sql(side, "SELECT * FROM user_profile.users ORDER BY id")
}

describe("Feature 4: MySQL baseline and delta replication through OCI", () => {
  beforeAll(async () => {
    for (const side of ["proposer", "replica"] as const) {
      const deadline = Date.now() + 120_000
      let ready = false
      while (Date.now() < deadline) {
        try { if (sql(side, "SELECT 1") === "1") { ready = true; break } } catch {}
        await sleep(2000)
      }
      if (!ready) throw new Error(`${side} MySQL never became ready`)
    }
  }, 300_000)

  it("enables GTIDs and row-based binlogs", () => {
    expect(sql("proposer", "SELECT @@gtid_mode, @@binlog_format")).toBe("ON\tROW")
    expect(sql("replica", "SELECT @@gtid_mode")).toBe("ON")
    expect(sql("proposer", "SHOW MASTER STATUS").split("\t")[2].split(",").sort()).toEqual(EXPORTED_SCHEMAS.split(",").sort())
  })

  it("publishes baseline, binlogs, and application manifest to OCI", async () => {
    sql("proposer", "CREATE DATABASE IF NOT EXISTS user_profile; USE user_profile; CREATE TABLE users(id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO users VALUES (1,'alice'),(2,'bob');")
    sql("proposer", "CREATE DATABASE public_catalog; USE public_catalog; CREATE TABLE items(id INT PRIMARY KEY, name VARCHAR(50)); INSERT INTO items VALUES (1,'public-item');")
    sql("proposer", `CREATE DATABASE private_auth; USE private_auth; CREATE TABLE credentials(id INT PRIMARY KEY, secret VARCHAR(128)); INSERT INTO credentials VALUES (1,'${SENSITIVE_SECRET}');`)
    // Delta publication works before any baseline and does not create one.
    const pending = publish("delta")
    expect(pending.manifest).toBe("")
    const staged = JSON.parse(readFileSync(join(PUBLICATION_STATE, "delta.json"), "utf8"))
    const artifact = JSON.parse(command("oras", ["manifest", "fetch", "--plain-http", `${OCI_ADDRESS}/binlog_app@${staged.digest}`]))
    expect(artifact.layers.length).toBeGreaterThan(0)
    // A registry may return NAME_UNKNOWN until the first tag exists.
    try {
      expect(command("oras", ["repo", "tags", "--plain-http", `${OCI_ADDRESS}/binlog_app`]).trim()).toBe("")
    } catch (error) {
      if (!String(error).includes("name unknown")) throw error
    }
    expect(() => command("oras", ["repo", "tags", "--plain-http", `${OCI_ADDRESS}/baseline_app`])).toThrow()
    const tags = publish("baseline")
    baselineTag = tags.baseline
    deltaTag = tags.delta
    deltaGtidEnd = tags.deltaGtidEnd
    const directory = mkdtempSync(join(tmpdir(), "mysql-manifest-"))
    try {
      command("oras", ["pull", "--plain-http", `${OCI_ADDRESS}/app-manifests:${tags.manifest}`, "-o", directory])
      const manifest = Bun.YAML.parse(readFileSync(join(directory, "application-manifest.yaml"), "utf8")) as any
      expect(manifest.owner).toBe("test-proposer")
      expect(manifest.databases[0].baseline.repo).toBe("baseline_app")
      expect(manifest.databases[0].delta.repo).toBe("binlog_app")
      expect(manifest.databases[0].exported_schemas).toContain("user_profile")
      expect(Object.keys(manifest.databases[0].baseline).sort()).toEqual(["gtid_end", "repo", "tag"])
      expect(Object.keys(manifest.databases[0].delta).sort()).toEqual(["gtid_end", "gtid_start", "repo", "tag"])
      expect(manifest.databases[0].tag).toBe(tags.manifest)
      expect(manifest.databases[0].baseline.tag).toBe(tags.baseline)
      expect(manifest.databases[0].delta.tag).toBe(tags.delta)
      expect(tags.baseline).not.toBe(tags.delta)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 240_000)

  it("restores baseline directly from S3 and downloads only deltas for replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-s3-"))
    const env = {
      OCI_ADDRESS, BASELINE_REPO: "baseline_app", BASELINE_TAG: baselineTag,
      DELTA_REPO: "binlog_app", DELTA_TAG: deltaTag, OUTPUT_DIR: directory, STORAGE_MODE: "s3",
      S3_BUCKET: "mysql-e2e", S3_PREFIX: "mysql", AWS_REGION: "us-east-1",
      S3_ENDPOINT: "http://mysql-replica-s3.replica-ns.svc.cluster.local:8333",
      AWS_ACCESS_KEY_ID: "replica", AWS_SECRET_ACCESS_KEY: "change-me",
    }
    try {
      command("sync.sh", [], env)
      const path = readFileSync(join(directory, "baseline-path"), "utf8").trim()
      expect(readdirSync(path).sort()).toEqual(["@.done.json", "@.json"])
      command("import.sh", [], { ...env, ...databaseEnv("replica"), IMPORT_MODE: "restore" })
      expect(rows("replica")).toBe(rows("proposer"))
      expect(readdirSync(path).sort()).toEqual(["@.done.json", "@.json"])
      command("import.sh", [], { ...env, ...databaseEnv("replica"), IMPORT_MODE: "replay" })
      const batches = readdirSync(join(directory, "deltas"))
      expect(batches.length).toBe(1)
      expect(existsSync(join(directory, "deltas", batches[0], ".replayed"))).toBe(true)
      expect(existsSync(join(directory, "deltas", batches[0], "download"))).toBe(false)
      expect(sql("replica", "SELECT @@GLOBAL.gtid_executed")).toBe(deltaGtidEnd)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 240_000)

  it("keeps incomplete syncs out of replay and retains failed replay batches", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-retry-"))
    const env = { ...databaseEnv("replica"), OUTPUT_DIR: directory, OCI_ADDRESS }
    try {
      expect(() => command("sync.sh", [], {
        OUTPUT_DIR: directory, OCI_ADDRESS, DELTA_REPO: "missing_delta", DELTA_TAG: "20000101000000000000000",
      })).toThrow()
      expect(readdirSync(join(directory, "deltas"))).toEqual([])
      const partial = join(directory, ".staging", "unfinished", "delta")
      mkdirSync(partial, { recursive: true })
      writeFileSync(join(partial, "bin.000001"), "incomplete binlog")
      command("import.sh", [], { ...env, IMPORT_MODE: "replay" })
      const bad = join(directory, "deltas", "20000101000000000000000", "delta")
      mkdirSync(bad, { recursive: true })
      writeFileSync(join(bad, "bin.000001"), "corrupt binlog")
      expect(() => command("import.sh", [], { ...env, IMPORT_MODE: "replay" })).toThrow("delta replay failed")
      expect(existsSync(join(bad, "bin.000001"))).toBe(true)
      expect(existsSync(join(bad, "..", ".replayed"))).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it("syncs only new binlogs across overlapping publications and failed retries", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-sync-overlap-"))
    const repo = `sync-overlap-${Date.now()}`
    const firstTag = "20000101000000000000001"
    const secondTag = "20000101000000000000002"
    try {
      mkdirSync(join(directory, "delta"))
      const files = ["delta/bin.000001", "delta/bin.000002", "delta/bin.000003"]
      files.forEach((file, index) => writeFileSync(join(directory, file), `binlog ${index}\n`))
      const push = (tag: string, layers: string[]) => execFileSync("oras", [
        "push", "--plain-http", "--artifact-type", "application/vnd.paid.mysql.delta.v1",
        "--annotation", "org.paid.mysql.gtid-start=", "--annotation", "org.paid.mysql.gtid-end=",
        "--annotation", `org.paid.mysql.exported-schemas=${EXPORTED_SCHEMAS}`,
        `${OCI_ADDRESS}/${repo}:${tag}`, ...layers,
      ], { cwd: directory, encoding: "utf8", timeout: 60_000 })
      push(firstTag, files.slice(0, 1))
      push(secondTag, files)
      const manifest = JSON.parse(command("oras", ["manifest", "fetch", "--plain-http", `${OCI_ADDRESS}/${repo}:${secondTag}`]))
      const blockedDigest = manifest.layers.find((layer: any) => layer.annotations["org.opencontainers.image.title"] === files[2]).digest
      const realOras = command("sh", ["-c", "command -v oras"]).trim()
      const wrapper = join(directory, "bin")
      mkdirSync(wrapper)
      writeFileSync(join(wrapper, "oras"), `#!/bin/bash
if [[ "$1 $2" == "blob fetch" ]]; then
  if [[ -n "\${BLOCK_DIGEST:-}" && "$*" == *"$BLOCK_DIGEST"* ]]; then exit 1; fi
  printf '%s\\n' "$*" >> "$FETCH_LOG"
fi
exec "$REAL_ORAS" "$@"
`)
      chmodSync(join(wrapper, "oras"), 0o755)
      for (const storage of ["filesystem", "s3"]) {
        const output = join(directory, storage)
        const log = join(directory, `${storage}.fetches`)
        const env = {
          OCI_ADDRESS, OUTPUT_DIR: output, DELTA_REPO: repo, STORAGE_MODE: storage,
          PATH: `${wrapper}:${process.env.PATH}`, REAL_ORAS: realOras, FETCH_LOG: log,
          S3_BUCKET: "mysql-e2e", S3_PREFIX: repo, AWS_REGION: "us-east-1",
          S3_ENDPOINT: "http://mysql-replica-s3.replica-ns.svc.cluster.local:8333",
          AWS_ACCESS_KEY_ID: "replica", AWS_SECRET_ACCESS_KEY: "change-me",
        }
        const fetched = () => readFileSync(log, "utf8").trim().split("\n").length
        command("sync.sh", [], { ...env, DELTA_TAG: firstTag })
        expect(fetched()).toBe(1)
        expect(() => command("sync.sh", [], { ...env, DELTA_TAG: secondTag, BLOCK_DIGEST: blockedDigest })).toThrow()
        expect(fetched()).toBe(2)
        expect(readdirSync(join(output, "deltas")).length).toBe(1)
        command("sync.sh", [], { ...env, DELTA_TAG: secondTag })
        expect(fetched()).toBe(3)
        expect(readdirSync(join(output, "deltas")).length).toBe(2)
        command("sync.sh", [], { ...env, DELTA_TAG: secondTag })
        expect(fetched()).toBe(3)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 240_000)

  it("restores the original baseline and its GTID boundary", () => {
    importArtifacts(baselineTag)
    expect(rows("replica")).toBe("1\talice\n2\tbob")
    expect(rows("replica")).toBe(rows("proposer"))
    const sourceGtid = sql("proposer", "SELECT @@GLOBAL.gtid_executed")
    expect(sql("replica", `SELECT GTID_SUBSET('${sourceGtid}', @@GLOBAL.gtid_executed)`)).toBe("1")
  }, 240_000)

  it("SELECT * returns identical data on replica and proposer", () => {
    expect(rows("proposer")).toBe("1\talice\n2\tbob")
    expect(rows("replica")).toBe(rows("proposer"))
  })

  it("exports selected schemas through OCI without sensitive baseline or delta data", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-schema-isolation-"))
    try {
      // These schemas existed before the baseline; the selection never changes.
      command("oras", ["pull", "--plain-http", `${OCI_ADDRESS}/baseline_app:${baselineTag}`, "-o", directory])
      const baselineDirectory = join(directory, "baseline")
      expect(existsSync(join(directory, "baseline.tgz"))).toBe(false)
      expect(readdirSync(baselineDirectory).join("\n")).not.toContain("private_auth")
      expect(existsSync(join(baselineDirectory, "@.done.json"))).toBe(true)
      const metadata = JSON.parse(readFileSync(join(baselineDirectory, "@.json"), "utf8"))
      expect(metadata.schemas.sort()).toEqual(EXPORTED_SCHEMAS.split(",").sort())
      expect(sql("replica", "SELECT * FROM public_catalog.items")).toBe("1\tpublic-item")
      expect(sql("replica", "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='private_auth'")).toBe("0")

      // Qualified row writes must still respect filtering with another default DB.
      sql("proposer", `USE user_profile; BEGIN; UPDATE private_auth.credentials SET secret='${SENSITIVE_SECRET}-updated' WHERE id=1; UPDATE public_catalog.items SET name='public-updated' WHERE id=1; COMMIT;`)
      sql("proposer", "USE private_auth; CREATE TABLE private_changes(id INT PRIMARY KEY); INSERT INTO private_changes VALUES (99);")
      const tags = publish("delta")
      expect(artifactDigest("baseline_app", tags.baseline)).toBe(artifactDigest("baseline_app", baselineTag))
      command("oras", ["pull", "--plain-http", `${OCI_ADDRESS}/binlog_app:${tags.delta}`, "-o", directory])
      const files = command("find", [join(directory, "delta"), "-type", "f"]).trim().split("\n")
      expect(files.length).toBeGreaterThan(0)
      const decoded = command("mysqlbinlog", ["--base64-output=DECODE-ROWS", "--verbose", ...files.sort()])
      expect(decoded).toContain("public_catalog")
      expect(decoded).not.toContain("private_auth")
      expect(decoded).not.toContain(SENSITIVE_SECRET)
      for (const file of files) expect(readFileSync(file).includes(Buffer.from(SENSITIVE_SECRET))).toBe(false)
      importArtifacts("", tags.delta, tags.deltaGtidEnd)
      expect(sql("replica", "SELECT * FROM public_catalog.items")).toBe("1\tpublic-updated")
      expect(rows("replica")).toBe(rows("proposer"))
      expect(sql("replica", "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='private_auth'")).toBe("0")
      expect(gtids(sql("replica", "SELECT @@GLOBAL.gtid_executed"))).toBe(gtids(tags.deltaGtidEnd))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 240_000)

  it("rejects a schema selection that does not match source binlog filtering", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-invalid-selection-"))
    try {
      expect(() => command("mysql-export-baseline.js", [], {
        ...databaseEnv("proposer"), MYSQL_EXPORT_SCHEMAS: "private_auth", OUTPUT_DIR: join(directory, "baseline"),
      })).toThrow("binlog-do-db exactly to MYSQL_EXPORT_SCHEMAS")
      expect(() => command("mysql-export-binlogs.sh", [], {
        ...databaseEnv("proposer"), MYSQL_EXPORT_SCHEMAS: "private_auth", OUTPUT_DIR: join(directory, "delta"),
      })).toThrow("binlog-do-db exactly to MYSQL_EXPORT_SCHEMAS")
      expect(command("find", [directory, "-type", "f"]).trim()).toBe("")
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it("derives coverage across adjacent closed files while writes continue after rotation", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-boundary-"))
    try {
      sql("proposer", "USE user_profile; CREATE TABLE boundary_test(id INT PRIMARY KEY); SET GTID_NEXT='00000000-0000-0000-0000-000000000123:9007199254740993'; INSERT INTO boundary_test VALUES (7); SET GTID_NEXT='AUTOMATIC';")
      command("mysql-export-baseline.js", [], { ...databaseEnv("proposer"), OUTPUT_DIR: join(directory, "baseline") })
      const metadata = JSON.parse(readFileSync(join(directory, "baseline/@.json"), "utf8"))
      sql("proposer", "INSERT INTO user_profile.boundary_test VALUES (8); FLUSH BINARY LOGS; UPDATE user_profile.boundary_test SET id=80 WHERE id=8; INSERT INTO user_profile.boundary_test VALUES (9);")
      const completedGtid = sql("proposer", "SELECT @@GLOBAL.gtid_executed")
      const realMysql = command("bash", ["-c", "command -v mysql"]).trim()
      const wrapper = join(directory, "mysql")
      writeFileSync(wrapper, `#!/bin/bash
set -euo pipefail
if [[ "$*" == *"FLUSH BINARY LOGS; SHOW MASTER STATUS"* ]]; then
  "${realMysql}" "$@"
  "${realMysql}" -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -Nse 'INSERT INTO user_profile.boundary_test VALUES (99)' >/dev/null
else
  exec "${realMysql}" "$@"
fi
`)
      chmodSync(wrapper, 0o755)
      const boundary = JSON.parse(command("mysql-export-binlogs.sh", [], {
        ...databaseEnv("proposer"), PATH: `${directory}:${process.env.PATH}`,
        OUTPUT_DIR: join(directory, "delta"),
      }))
      expect(sql("proposer", `SELECT GTID_SUBSET('${boundary.gtid_end}', @@GLOBAL.gtid_executed)`)).toBe("1")
      expect(sql("proposer", `SELECT GTID_SUBSET(@@GLOBAL.gtid_executed, '${boundary.gtid_end}')`)).toBe("0")
      expect(boundary.gtid_end).not.toContain("\\n")
      expect(sql("proposer", `SELECT GTID_SUBSET('${boundary.gtid_end}', '${completedGtid}') AND GTID_SUBSET('${completedGtid}', '${boundary.gtid_end}')`)).toBe("1")
      expect(sql("proposer", `SELECT GTID_SUBSET('${boundary.gtid_start}', '${metadata.gtidExecuted}')`)).toBe("1")
      const files = readdirSync(join(directory, "delta")).sort()
      expect(files.length).toBeGreaterThanOrEqual(2)
      for (let index = 1; index < files.length; index++) {
        expect(Number(files[index].split(".").pop())).toBe(Number(files[index-1].split(".").pop()) + 1)
      }
      command("mysql-import-baseline.js", [], { ...databaseEnv("replica"), BASELINE_DIR: join(directory, "baseline") })
      command("mysql-import-binlogs.sh", [], { ...databaseEnv("replica"), DELTA_DIR: join(directory, "delta") })
      expect(sql("replica", "SELECT id FROM user_profile.boundary_test ORDER BY id")).toBe("7\n9\n80")
      expect(gtids(sql("replica", "SELECT @@GLOBAL.gtid_executed"))).toBe(gtids(boundary.gtid_end))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 180_000)

  it("replays a later delta without restoring a newer baseline", async () => {
    sql("proposer", "USE user_profile; INSERT INTO users VALUES (3,'charlie'); UPDATE users SET name='AliceUpdated' WHERE id=1; DELETE FROM users WHERE id=2;")
    expect(rows("replica")).toBe("1\talice\n2\tbob")
    const tags = publish("delta")
    expect(artifactDigest("baseline_app", tags.baseline)).toBe(artifactDigest("baseline_app", baselineTag))
    expect(tags.delta).not.toBe(deltaTag)
    deltaTag = tags.delta
    deltaGtidEnd = tags.deltaGtidEnd
    const logs = importArtifacts("", deltaTag, deltaGtidEnd)
    expect(logs).toContain("delta import complete")
    expect(logs).not.toContain("baseline import complete")
    expect(rows("replica")).toBe("1\tAliceUpdated\n3\tcharlie")
    expect(rows("replica")).toBe(rows("proposer"))
  }, 420_000)

  it("replaying the same delta is idempotent", () => {
    const before = sql("replica", "SELECT @@GLOBAL.gtid_executed")
    importArtifacts("", deltaTag, "ignored-not-a-gtid")
    expect(sql("replica", "SELECT @@GLOBAL.gtid_executed")).toBe(before)
    expect(rows("replica")).toBe(rows("proposer"))
  }, 240_000)

  it("restores baseline GTIDs and skips overlapping delta transactions", () => {
    const directory = mkdtempSync(join(tmpdir(), "mysql-gtid-"))
    sql("proposer", "USE user_profile; DROP TABLE IF EXISTS gtid_replay; CREATE TABLE gtid_replay(id INT PRIMARY KEY, counter INT); INSERT INTO gtid_replay VALUES (1,1);")
    try {
      sql("proposer", "UPDATE user_profile.gtid_replay SET counter=counter+1 WHERE id=1; INSERT INTO user_profile.gtid_replay VALUES (2,1);")
      command("mysql-export-baseline.js", [], {
        ...databaseEnv("proposer"), OUTPUT_DIR: join(directory, "baseline"),
      })
      const metadata = JSON.parse(readFileSync(join(directory, "baseline/@.json"), "utf8"))
      const snapshotGtid = sql("proposer", "SELECT @@GLOBAL.gtid_executed")
      expect(gtids(metadata.gtidExecuted)).toBe(gtids(snapshotGtid))
      const localInfile = sql("replica", "SELECT @@GLOBAL.local_infile")
      command("mysql-import-baseline.js", [], { ...databaseEnv("replica"), BASELINE_DIR: join(directory, "baseline") })
      expect(sql("replica", "SELECT @@GLOBAL.local_infile")).toBe(localInfile)
      expect(sql("replica", "SELECT @@GLOBAL.gtid_executed")).toBe(snapshotGtid)
      expect(sql("replica", "SELECT * FROM user_profile.gtid_replay ORDER BY id")).toBe("1\t2\n2\t1")
      sql("proposer", "UPDATE user_profile.gtid_replay SET counter=counter+1 WHERE id=1; INSERT INTO user_profile.gtid_replay VALUES (3,1);")
      const boundary = JSON.parse(command("mysql-export-binlogs.sh", [], { ...databaseEnv("proposer"), OUTPUT_DIR: join(directory, "delta") }).trim())
      const deltaEnd = boundary.gtid_end
      expect(sql("proposer", `SELECT GTID_SUBSET('${boundary.gtid_start}', '${snapshotGtid}')`)).toBe("1")
      expect(existsSync(join(directory, "delta/boundary.json"))).toBe(false)
      for (let attempt = 0; attempt < 2; attempt++) {
        command("mysql-import-binlogs.sh", [], { ...databaseEnv("replica"), DELTA_DIR: join(directory, "delta"), DELTA_GTID_END: deltaEnd })
        expect(sql("replica", "SELECT * FROM user_profile.gtid_replay ORDER BY id")).toBe("1\t3\n2\t1\n3\t1")
        expect(gtids(sql("replica", "SELECT @@GLOBAL.gtid_executed"))).toBe(gtids(deltaEnd))
      }
      expect(sql("replica", "SELECT @@GLOBAL.gtid_executed")).toBe(sql("proposer", "SELECT @@GLOBAL.gtid_executed"))
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 180_000)

  it("replica restores a new baseline through scheduled jobs", async () => {
    const previous = rows("replica")
    sql("proposer", "USE user_profile; INSERT INTO users VALUES (4,'dana'),(5,'erin'); UPDATE users SET name='CharlieUpdated' WHERE id=3;")
    const expected = rows("proposer")
    expect(expected).toBe("1\tAliceUpdated\n3\tCharlieUpdated\n4\tdana\n5\terin")
    expect(rows("replica")).toBe(previous)
    expect(previous).not.toBe(expected)

    // Chart-created CronJobs follow latest; the tests only resume their schedules.
    let replica = previous
    try {
      await schedulePublisher("baseline", false)
      await schedulePublisher("delta", false)
      await schedule("replica-ns", "mysql-replica-sync", false)
      await schedule("replica-ns", "mysql-replica-importer", false)
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        try { replica = rows("replica"); if (replica === expected) break } catch {}
        await sleep(2000)
      }
      expect(replica).toBe(expected)
      expect(rows("replica")).toBe(rows("proposer"))
    } finally {
      await schedulePublisher("baseline", true)
      await schedulePublisher("delta", true)
      await schedule("replica-ns", "mysql-replica-importer", true)
      await schedule("replica-ns", "mysql-replica-sync", true)
    }
  }, 240_000)

  it("scheduled replica follows newer deltas without a new baseline", async () => {
    await schedulePublisher("baseline", true)
    const baselineDigest = artifactDigest("baseline_app", "latest")
    const previous = rows("replica")
    sql("proposer", "USE user_profile; INSERT INTO users VALUES (6,'frank'); UPDATE users SET name='DanaUpdated' WHERE id=4;")
    const expected = rows("proposer")
    expect(expected).toBe("1\tAliceUpdated\n3\tCharlieUpdated\n4\tDanaUpdated\n5\terin\n6\tfrank")
    expect(rows("replica")).toBe(previous)
    // Only delta publication and replica import are resumed; the baseline stays suspended.
    try {
      await schedulePublisher("delta", false)
      await schedule("replica-ns", "mysql-replica-sync", false)
      await schedule("replica-ns", "mysql-replica-importer", false)
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        try { if (rows("replica") === expected) break } catch {}
        await sleep(2000)
      }
      expect(rows("replica")).toBe(expected)
      expect(sql("replica", "SELECT @@GLOBAL.gtid_executed")).toBe(sql("proposer", "SELECT @@GLOBAL.gtid_executed"))
      expect(artifactDigest("baseline_app", "latest")).toBe(baselineDigest)
    } finally {
      await schedulePublisher("delta", true)
      await schedule("replica-ns", "mysql-replica-importer", true)
      await schedule("replica-ns", "mysql-replica-sync", true)
    }
  }, 240_000)

  it("restores baseline, waits for missing deltas after MySQL expiration, then resumes replay", async () => {
    const retention = sql("proposer", "SELECT @@GLOBAL.binlog_expire_logs_seconds")
    expect(Number(retention)).toBeGreaterThan(0)
    const directory = mkdtempSync(join(tmpdir(), "mysql-gap-"))
    try {
      const baseline = publish("baseline")
      sql("proposer", "SET GLOBAL binlog_expire_logs_seconds=1")
      await sleep(2100)
      sql("proposer", "FLUSH BINARY LOGS")
      // No new transactions: losing the original snapshot binlog is harmless.
      const covered = publish("delta")
      expect(artifactDigest("baseline_app", covered.baseline)).toBe(artifactDigest("baseline_app", baseline.baseline))
      expect(gtids(covered.deltaGtidEnd)).toBe(gtids(sql("proposer", "SELECT @@GLOBAL.gtid_executed")))
      importArtifacts(covered.baseline, covered.delta, covered.deltaGtidEnd)
      const before = rows("replica")
      sql("proposer", "INSERT INTO user_profile.boundary_test VALUES (100)")
      // Close the transaction's file before waiting for its retention age.
      const expiredFile = sql("proposer", "SHOW MASTER STATUS").split("\t")[0]
      const missing = publish("delta")
      await sleep(2100)
      sql("proposer", "FLUSH BINARY LOGS")
      expect(sql("proposer", "SHOW BINARY LOGS")).not.toContain(expiredFile)
      // MySQL expired a transaction that the snapshot does not contain.
      const incompatible = publish("delta")
      expect(incompatible.manifest).not.toBe("")
      const env = { ...databaseEnv("replica"), OCI_ADDRESS, OUTPUT_DIR: directory }
      command("sync.sh", [], {
        OCI_ADDRESS, OUTPUT_DIR: directory, BASELINE_REPO: "baseline_app", BASELINE_TAG: baseline.baseline,
        DELTA_REPO: "binlog_app", DELTA_TAG: incompatible.delta,
      })
      command("import.sh", [], { ...env, IMPORT_MODE: "restore" })
      expect(rows("replica")).toBe(before)
      expect(sql("replica", "SELECT COUNT(*) FROM user_profile.boundary_test WHERE id=100")).toBe("0")
      expect(() => command("import.sh", [], { ...env, IMPORT_MODE: "replay" })).toThrow("waiting for missing deltas")
      expect(sql("replica", "SELECT COUNT(*) FROM user_profile.boundary_test WHERE id=100")).toBe("0")
      for (const batch of readdirSync(join(directory, "deltas"))) {
        expect(existsSync(join(directory, "deltas", batch, "delta"))).toBe(true)
        expect(existsSync(join(directory, "deltas", batch, ".replayed"))).toBe(false)
      }
      command("sync.sh", [], { OCI_ADDRESS, OUTPUT_DIR: directory, DELTA_REPO: "binlog_app", DELTA_TAG: missing.delta })
      command("import.sh", [], { ...env, IMPORT_MODE: "replay" })
      expect(sql("replica", "SELECT COUNT(*) FROM user_profile.boundary_test WHERE id=100")).toBe("1")
      expect(gtids(sql("replica", "SELECT @@GLOBAL.gtid_executed"))).toBe(gtids(incompatible.deltaGtidEnd))
    } finally {
      sql("proposer", `SET GLOBAL binlog_expire_logs_seconds=${Number(retention)}`)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 180_000)

})
