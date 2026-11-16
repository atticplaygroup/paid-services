import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { stageCharts } from "./release"

function command(args: string[]) {
  const result = Bun.spawnSync(args)
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString()
}

test("all release charts render versioned PAID images, including dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "paid-release-render-"))
  const settings: Record<string, string> = {
    cashier: "",
    index: "env.mysqlDsn=user:password@tcp(mysql:3306)/routing,mysqlHttp.enabled=true,mysqlHttp.adminDsn=root:password@tcp(mysql:3306)/routing,mysqlHttp.access.tables.routing[0]=advertisements",
    meter: "",
    "mysql-proposer": "packer.ociAddress=registry.example:5000",
    "mysql-replica": "importer.ociAddress=registry.example:5000,mysqlHttp.enabled=true,mysqlHttp.adminDsn=root:password@tcp(mysql-replica:3306)/,mysqlHttp.access.schemas[0]=public_catalog,meter.enabled=true",
    kvstore: "env.validAudience=provider,env.accountDomains[0]=provider.example,s3.endpoint=s3.example:9000,s3.existingSecret=s3,redisAddress=redis:6379",
    exchange: "databaseURL=postgres://example,tokenIssuer=https://exchange.example,identitySecret=identity,env.accountDomains[0]=exchange.example",
    oci: "env.kvstoreAddress=http://storage.example,env.deductionAddress=meter:9193,env.dpopMasterSecret=example,env.accountDomains[0]=oci.example",
    "outproxy-with-faucet": "cashier.existingSecret=cashier,outproxyExistingSecret=outproxy,cashierAccountSalt=example,tls.existingProxySecret=proxy",
  }
  try {
    for (const chart of stageCharts("v0.1.123", directory)) {
      command(["helm", "dependency", "update", chart])
      const args = ["helm", "template", "test", chart]
      if (settings[basename(chart)]) args.push("--set", settings[basename(chart)])
      const rendered = command(args)
      const paidImages = [...rendered.matchAll(/image:\s*["']?(ghcr\.io\/atticplaygroup\/[^\s"']+)/g)].map(match => match[1])
      expect(paidImages.length).toBeGreaterThan(0)
      for (const image of paidImages) expect(image).toMatch(/^ghcr\.io\/atticplaygroup\/paid-services\/[a-z0-9-]+:v0\.1\.123$/)
      if (["index", "mysql-replica"].includes(basename(chart))) {
        expect(rendered).toContain('command: ["/mysql-http", "--provision"]')
        expect(rendered).toContain('command: ["/mysql-http"]')
        expect(rendered).toContain('path: "/sql"')
        expect(rendered).toContain('paid.meter: { service: mysql }')
        expect(rendered).toContain('tag: meter_service')
        expect(rendered).toContain('MAX_RESULT_BYTES, value: "8388608"')
      }
      if (basename(chart) === "index") {
        expect(rendered).toContain("name: test-account")
        expect(rendered).toContain("address: test-account")
        expect(rendered).toContain("address: test-authz-http")
        expect(rendered).toContain("address: test-deduction")
      }
      if (basename(chart) === "kvstore") {
        // External storage references independently provisioned read-only
        // credentials; disabling direct access must remove their dependency.
        expect(rendered).toContain("name: s3-readonly")
        expect(rendered).toContain("envoy.filters.http.aws_request_signing")
        const disabled = command([...args, "--set", "s3.directAccess.enabled=false"])
        expect(disabled).not.toContain("s3-readonly")
        expect(disabled).not.toContain("envoy.filters.http.aws_request_signing")
        expect(disabled).not.toContain("AWS_ACCESS_KEY_ID")

        const embedded = command([...args, "--set", "s3.enabled=true,s3.secure=false,s3.existingSecret=,s3.accessKey=writer,s3.secretKey=writer-secret"])
        const identities = JSON.parse(embedded.match(/s3\.json: \|\s*([^\n]+)/)![1]).identities
        const reader = identities.find((identity: { name: string }) => identity.name === "direct-readonly")
        expect(reader.actions).toEqual(["Read:applications", "List:applications"])
        expect(reader.credentials[0].accessKey).not.toBe("writer")
        expect(reader.credentials[0].secretKey).not.toBe("writer-secret")
        expect(embedded).toContain(`accessKey: "${reader.credentials[0].accessKey}"`)
        expect(embedded).toContain(`secretKey: "${reader.credentials[0].secretKey}"`)
      }
      expect(rendered).not.toContain("172.19.0.2")
      expect(rendered).not.toMatch(/image:.*:(?:main|dev)["']?\s*$/m)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
