import { test, expect } from "bun:test"
import { mkdtemp, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("failed OCI upload aborts publication without recording a usable baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realworld-publication-"))
  try {
    await Bun.write(join(directory, "oras"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$ORAS_ARGUMENTS"\nexit 42\n')
    await Bun.write(join(directory, "mysql-export-baseline.js"), '#!/bin/bash\nmkdir -p "$OUTPUT_DIR"\nprintf \'{"gtidExecuted":"abc:1"}\' > "$OUTPUT_DIR/@.json"\n')
    await chmod(join(directory, "oras"), 0o755); await chmod(join(directory, "mysql-export-baseline.js"), 0o755)
    const process = Bun.spawn(["bash", resolve("charts/mysql-proposer/files/publish.sh")], { env: {
      ...globalThis.process.env, PATH: `${directory}:${globalThis.process.env.PATH}`,
      MYSQL_HOST: "unused", MYSQL_PORT: "3306", MYSQL_USER: "unused", MYSQL_PASSWORD: "unused", MYSQL_EXPORT_SCHEMAS: "realworld",
      OCI_ADDRESS: "unused:3000", OCI_USER_ID: "intended-local-principal", BASELINE_REPO: "baseline", DELTA_REPO: "delta", MANIFEST_REPO: "manifest", APPLICATION: "realworld", OWNER: "owner", OUTPUT_DIR: join(directory, "output"), PUBLISH_STATE_DIR: join(directory, "state"), ORAS_ARGUMENTS: join(directory, "args"),
    }, stdout: "pipe", stderr: "pipe" })
    const [exit, output] = await Promise.all([process.exited, new Response(process.stdout).text()])
    expect(exit).toBe(42)
    expect(output).not.toContain("artifact published")
    expect(await Bun.file(join(directory, "state/baseline.json")).exists()).toBe(false)
    const args = await Bun.file(join(directory, "args")).text()
    expect(args).toContain("x-user-id:intended-local-principal")
    expect(args).toMatch(/x-request-id:[0-9a-f-]{36}/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
