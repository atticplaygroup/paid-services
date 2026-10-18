import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { defaultPrefix, images, validatePrefix, validateVersion } from "./images"

const root = resolve(import.meta.dir, "../..")
export const chartImages: Record<string, string> = {
  cashier: "cashier", exchange: "infrastructure", kvstore: "infrastructure", meter: "infrastructure",
  "mysql-proposer": "mysql-tools", "mysql-replica": "mysql-tools", oci: "oci",
}
const chartNames = [...Object.keys(chartImages), "outproxy-with-faucet"]

export function stageCharts(version: string, destination: string, prefix = defaultPrefix) {
  validateVersion(version)
  validatePrefix(prefix)
  const chartVersion = version.slice(1)
  for (const name of chartNames) {
    const directory = join(destination, name)
    cpSync(join(root, "charts", name), directory, { recursive: true, filter: source =>
      !source.endsWith(".tgz") && !source.endsWith("Chart.lock") })
    const metadataPath = join(directory, "Chart.yaml")
    const metadata = Bun.YAML.parse(readFileSync(metadataPath, "utf8")) as any
    metadata.version = chartVersion
    metadata.appVersion = version
    for (const dependency of metadata.dependencies ?? []) dependency.version = chartVersion
    writeFileSync(metadataPath, Bun.YAML.stringify(metadata))
    const valuesPath = join(directory, "values.yaml")
    const values = Bun.YAML.parse(readFileSync(valuesPath, "utf8")) as any
    if (name === "outproxy-with-faucet") {
      values.outproxyImage = `${prefix}/outproxy:${version}`
      values.cashierImage = `${prefix}/cashier:${version}`
    } else {
      const key = name === "oci" ? "ociImage" : "image"
      values[key].repository = `${prefix}/${chartImages[name]}`
      values[key].tag = version
    }
    if (name === "kvstore") {
      values.s3.retentionRules.image.repository = `${prefix}/s3-retention-rules`
      values.s3.retentionRules.image.tag = version
    }
    writeFileSync(valuesPath, Bun.YAML.stringify(values))
  }
  return chartNames.map(name => join(destination, name))
}

function command(args: string[]) {
  const result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`Failed: ${args.join(" ")}`)
}

if (import.meta.main) {
  const version = process.argv[2] ?? ""
  const output = resolve(process.argv[3] ?? ".release")
  const prefix = process.env.IMAGE_PREFIX || defaultPrefix
  validateVersion(version)
  validatePrefix(prefix)
  // Verify published images before producing distributable charts.
  for (const image of images) command(["docker", "manifest", "inspect", `${prefix}/${image}:${version}`])
  const directories = stageCharts(version, join(output, "charts"), prefix)
  const packages = join(output, "packages")
  mkdirSync(packages, { recursive: true })
  for (const directory of directories) {
    command(["helm", "dependency", "update", directory])
    command(["helm", "package", directory, "--destination", packages])
  }
  console.log(`Release charts ready: ${packages}`)
}
