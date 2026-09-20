import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync } from "child_process"

const PROPOSER_NS = "proposer-ns"
const REPLICA_NS = "replica-ns"
const REGISTRY_NS = "registry-system"
const PROPOSER_POD = "mysql-proposer-0"
const REPLICA_POD = "mysql-replica-0"
const MYSQL_ROOT_PASSWORD = "root"
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim()

function kexec(pod: string, ns: string, cmd: string): string {
  return execFileSync("kubectl", ["exec", pod, "-n", ns, "--", "bash", "-c", cmd], {
    encoding: "utf-8",
    timeout: 60_000,
  })
}

function krun(cmd: string, env?: Record<string, string>): string {
  return execFileSync("bash", ["-c", cmd], { encoding: "utf-8", timeout: 120_000, env: { ...process.env, ...env } })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPod(ns: string, label: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = krun(`kubectl get pods -n ${ns} -l ${label} -o jsonpath='{.items[0].status.phase}'`)
      if (out.trim() === "Running") {
        const ready = krun(
          `kubectl get pods -n ${ns} -l ${label} -o jsonpath='{.items[0].status.containerStatuses[0].ready}'`,
        )
        if (ready.trim() === "true") return ready
      }
    } catch {
      // retry
    }
    await sleep(3000)
  }
  throw new Error(`Pod with label ${label} in ${ns} not Running after ${timeoutMs}ms`)
}

function sql(pod: string, ns: string, query: string): string {
  return kexec(
    pod,
    ns,
    `MYSQL_PWD=${MYSQL_ROOT_PASSWORD} mysql -uroot -e "${query.replace(/"/g, '\\"')}" 2>/dev/null`,
  )
}

describe("e2e-kind: Feature 4 PAID Database", () => {
  beforeAll(async () => {
    // Wait for proposer/replica MySQL pods
    await waitForPod(PROPOSER_NS, "app=mysql-proposer")
    await waitForPod(REPLICA_NS, "app=mysql-replica")
    console.log("Proposer and replica MySQL pods are Running")
  }, 180_000)

  it("proposer has GTID mode ON and row-based binlog", () => {
    const gtid = sql(PROPOSER_POD, PROPOSER_NS, "SHOW VARIABLES LIKE 'gtid_mode'")
    expect(gtid).toContain("ON")
    const format = sql(PROPOSER_POD, PROPOSER_NS, "SHOW VARIABLES LIKE 'binlog_format'")
    expect(format).toContain("ROW")
  }, 30_000)

  it("publish job exports baseline, pushes to OCI, and publishes manifest", async () => {
    // Seed data
    sql(
      PROPOSER_POD,
      PROPOSER_NS,
      "CREATE DATABASE IF NOT EXISTS user_profile; USE user_profile; CREATE TABLE IF NOT EXISTS users(id INT PRIMARY KEY, name VARCHAR(50)); TRUNCATE users; INSERT INTO users VALUES (1,'alice'),(2,'bob');",
    )

    // Run publish job
    krun(`kubectl delete job e2e-publish -n ${PROPOSER_NS} --ignore-not-found`)
    krun(`kubectl create job --from=cronjob/mysql-proposer-packer e2e-publish -n ${PROPOSER_NS}`)

    const deadline = Date.now() + 120_000
    let completed = false
    while (Date.now() < deadline) {
      const status = krun(
        `kubectl get job e2e-publish -n ${PROPOSER_NS} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`,
      )
      if (status.trim() === "True") {
        completed = true
        break
      }
      const failed = krun(
        `kubectl get job e2e-publish -n ${PROPOSER_NS} -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}'`,
      )
      if (failed.trim() === "True") break
      await sleep(5000)
    }
    expect(completed).toBe(true)
  }, 180_000)

  it("import job pulls baseline, restores into replica, and data matches", async () => {
    // Find the latest baseline tag from registry
    const catalog = krun(
      `kubectl exec deploy/registry -n ${REGISTRY_NS} -- wget -qO- http://localhost:5000/v2/baseline_app/tags/list`,
    )
    const jsonMatch = catalog.match(/\{.*\}/)
    if (!jsonMatch) throw new Error("no JSON in registry catalog: " + catalog)
    const tags = JSON.parse(jsonMatch[0])
    expect(tags.tags.length).toBeGreaterThan(0)
    const latestTag = tags.tags.sort().slice(-1)[0]
    console.log("Latest baseline tag:", latestTag)

    // Update importer CronJob with the tag
    krun(
      `helm upgrade replica $ROOT/charts/mysql-replica -n ${REPLICA_NS} --reuse-values --set importer.baselineRepo=baseline_app --set importer.baselineTag=${latestTag}`,
      { ROOT },
    )

    krun(`kubectl delete job e2e-import -n ${REPLICA_NS} --ignore-not-found`)
    krun(`kubectl create job --from=cronjob/mysql-replica-importer e2e-import -n ${REPLICA_NS}`)

    const deadline = Date.now() + 120_000
    let completed = false
    while (Date.now() < deadline) {
      const status = krun(
        `kubectl get job e2e-import -n ${REPLICA_NS} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`,
      )
      if (status.trim() === "True") {
        completed = true
        break
      }
      const failed = krun(
        `kubectl get job e2e-import -n ${REPLICA_NS} -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}'`,
      )
      if (failed.trim() === "True") {
        const logs = krun(
          `kubectl logs job/e2e-import -n ${REPLICA_NS} --tail=20`,
        )
        console.error("Import failed:", logs)
        break
      }
      await sleep(5000)
    }
    expect(completed).toBe(true)

    // Compare rows
    const src = sql(PROPOSER_POD, PROPOSER_NS, "SELECT * FROM user_profile.users ORDER BY id")
    const dst = sql(REPLICA_POD, REPLICA_NS, "SELECT * FROM user_profile.users ORDER BY id")
    console.log("Source:", src)
    console.log("Replica:", dst)
    expect(dst).toContain("alice")
    expect(dst).toContain("bob")
    expect(dst.trim()).toBe(src.trim())
  }, 180_000)

  it("delta replay converges replica after new writes on proposer", async () => {
    // Write more data on proposer
    sql(
      PROPOSER_POD,
      PROPOSER_NS,
      "USE user_profile; REPLACE INTO users VALUES (3,'charlie'); UPDATE users SET name='AliceUpdated' WHERE id=1;",
    )

    // Publish delta
    krun(`kubectl delete job e2e-publish-delta -n ${PROPOSER_NS} --ignore-not-found`)
    krun(
      `kubectl create job --from=cronjob/mysql-proposer-packer e2e-publish-delta -n ${PROPOSER_NS}`,
    )

    const pubDeadline = Date.now() + 120_000
    let pubDone = false
    while (Date.now() < pubDeadline) {
      const status = krun(
        `kubectl get job e2e-publish-delta -n ${PROPOSER_NS} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`,
      )
      if (status.trim() === "True") {
        pubDone = true
        break
      }
      await sleep(5000)
    }
    expect(pubDone).toBe(true)

    // Import delta
    const catalog = krun(
      `kubectl exec deploy/registry -n ${REGISTRY_NS} -- wget -qO- http://localhost:5000/v2/baseline_app/tags/list`,
    )
    const jsonMatch = catalog.match(/\{.*\}/)
    if (!jsonMatch) throw new Error("no JSON in registry catalog: " + catalog)
    const tags = JSON.parse(jsonMatch[0])
    const latestTag = tags.tags.sort().slice(-1)[0]
    krun(
      `helm upgrade replica $ROOT/charts/mysql-replica -n ${REPLICA_NS} --reuse-values --set importer.baselineTag=${latestTag}`,
      { ROOT },
    )
    krun(`kubectl delete job e2e-import-delta -n ${REPLICA_NS} --ignore-not-found`)
    krun(
      `kubectl create job --from=cronjob/mysql-replica-importer e2e-import-delta -n ${REPLICA_NS}`,
    )

    const impDeadline = Date.now() + 120_000
    let impDone = false
    while (Date.now() < impDeadline) {
      const status = krun(
        `kubectl get job e2e-import-delta -n ${REPLICA_NS} -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'`,
      )
      if (status.trim() === "True") {
        impDone = true
        break
      }
      await sleep(5000)
    }
    expect(impDone).toBe(true)

    // Compare
    const src = sql(PROPOSER_POD, PROPOSER_NS, "SELECT * FROM user_profile.users ORDER BY id")
    const dst = sql(REPLICA_POD, REPLICA_NS, "SELECT * FROM user_profile.users ORDER BY id")
    expect(dst).toContain("charlie")
    expect(dst).toContain("AliceUpdated")
    expect(dst.trim()).toBe(src.trim())
  }, 300_000)

  afterAll(async () => {
    // Clean up jobs
    krun(`kubectl delete job e2e-publish e2e-publish-delta -n ${PROPOSER_NS} --ignore-not-found`)
    krun(`kubectl delete job e2e-import e2e-import-delta -n ${REPLICA_NS} --ignore-not-found`)
  })
})
