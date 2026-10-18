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
    meter: "",
    "mysql-proposer": "packer.ociAddress=registry.example:5000",
    "mysql-replica": "importer.ociAddress=registry.example:5000",
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
      expect(rendered).not.toContain("172.19.0.2")
      expect(rendered).not.toMatch(/image:.*:(?:main|dev)["']?\s*$/m)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)
