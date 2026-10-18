export const images = ["infrastructure", "cashier", "outproxy", "oci", "mysql-tools", "s3-retention-rules"] as const
export const releaseVersion = /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/
export const defaultPrefix = "ghcr.io/atticplaygroup/paid-services"

export function validateVersion(version: string) {
  if (!releaseVersion.test(version) || version.endsWith("\n")) {
    throw new Error("Release version must be vMAJOR.MINOR.PATCH, e.g. v0.1.123")
  }
}

export function validatePrefix(prefix: string) {
  if (prefix.endsWith("\n") || !/^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(prefix)) {
    throw new Error("IMAGE_PREFIX must be registry/namespace[/repository]")
  }
}

export function buildMetadata(event: string, ref: string, sha: string, prNumber: string, requestedVersion = "") {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Expected a full commit SHA")
  const version = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : requestedVersion
  if (version) validateVersion(version)
  if (event === "pull_request" && !/^[1-9][0-9]*$/.test(prNumber)) throw new Error("Expected a PR number")
  return {
    tag: version || (event === "pull_request" ? `pr-${prNumber}-${sha}` : sha),
    version,
    developmentAlias: !version && event === "push" && ref === "refs/heads/master" ? "main" : "",
  }
}

if (import.meta.main) {
  const metadata = buildMetadata(
    process.env.CI_EVENT ?? "", process.env.CI_REF ?? "", process.env.CI_SHA ?? "",
    process.env.CI_PR_NUMBER ?? "", process.env.CI_RELEASE_VERSION ?? "",
  )
  const prefix = process.env.IMAGE_PREFIX || defaultPrefix
  validatePrefix(prefix)
  const publish = process.env.CI_PUBLISH === "true"
  const output = Object.entries({ ...metadata, prefix, publish: String(publish) })
    .map(([name, value]) => `${name}=${value}`).join("\n") + "\n"
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs")
    appendFileSync(process.env.GITHUB_OUTPUT, output)
  }
  console.log(output)
}
