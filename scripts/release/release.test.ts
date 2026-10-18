import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildMetadata, validateVersion } from "./images"
import { stageCharts } from "./release"

const sha = "a".repeat(40)
test("PR builds use distinct PR and commit tags", () => {
  expect(buildMetadata("pull_request", "refs/pull/1/merge", sha, "1").tag).toBe(`pr-1-${sha}`)
  expect(buildMetadata("pull_request", "refs/pull/2/merge", sha, "2").tag).toBe(`pr-2-${sha}`)
  expect(buildMetadata("pull_request", "refs/pull/1/merge", "b".repeat(40), "1").tag).not.toBe(`pr-1-${sha}`)
})
test("only master pushes update the main development alias", () => {
  expect(buildMetadata("push", "refs/heads/master", sha, "")).toEqual({ tag: sha, version: "", developmentAlias: "main" })
  expect(buildMetadata("workflow_dispatch", "refs/heads/feature", sha, "").developmentAlias).toBe("")
})
test("release tags are strictly stable semantic versions", () => {
  expect(buildMetadata("push", "refs/tags/v0.1.123", sha, "").tag).toBe("v0.1.123")
  for (const version of ["main", "vnext", "v01.2.3", "v1.2", "v1.2.3-rc.1", "v1.2.3\n", "1.2.3"]) {
    expect(() => validateVersion(version)).toThrow()
  }
})
test("release packaging stamps every chart and dependency without changing source charts", () => {
  const directory = mkdtempSync(join(tmpdir(), "paid-release-"))
  const source = readFileSync(join(import.meta.dir, "../../charts/cashier/values.yaml"), "utf8")
  try {
    const charts = stageCharts("v0.1.123", directory)
    expect(charts).toHaveLength(8)
    for (const chart of charts) {
      const metadata = Bun.YAML.parse(readFileSync(join(chart, "Chart.yaml"), "utf8")) as any
      expect(metadata.version).toBe("0.1.123")
      expect(metadata.appVersion).toBe("v0.1.123")
      for (const dependency of metadata.dependencies ?? []) expect(dependency.version).toBe("0.1.123")
    }
    expect(readFileSync(join(import.meta.dir, "../../charts/cashier/values.yaml"), "utf8")).toBe(source)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test("local Gitea release rehearsal uses only the configured registry", () => {
  const directory = mkdtempSync(join(tmpdir(), "paid-local-release-"))
  try {
    for (const chart of stageCharts("v0.1.123", directory, "localhost:5000/atticplaygroup/paid-services")) {
      const values = readFileSync(join(chart, "values.yaml"), "utf8")
      expect(values).toContain("localhost:5000/atticplaygroup/paid-services/")
      expect(values).not.toContain("ghcr.io/atticplaygroup/paid-services/")
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
