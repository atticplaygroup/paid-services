# Development images and releases

Every branch push runs unit tests, chart checks, image builds, and the kind integration suites. Pull requests run these checks too; newer feature-branch commits cancel superseded runs. Feature-branch pushes build images without publishing.

Pull requests from this repository use `pr-<number>-<commit-sha>` tags; forks build without publishing. Pushes to `master` publish commit-SHA tags and update the `main` development alias. The kind suites build the checked-out code and load commit-tagged images directly into their test clusters.

Chart image tags default to `Chart.yaml`'s `appVersion`. Source charts use `main`; release charts use a stable version such as `v0.1.123`. CI supplies explicit image overrides, so tests do not depend on the mutable `main` alias.

## Publish a release on GitHub

Choose an unused version and tag the tested commit:

```bash
git tag v0.1.123 <commit-sha>
git push origin v0.1.123
```

The **Images and releases** workflow validates the `vMAJOR.MINOR.PATCH` version, runs unit tests, and builds the application images. Images are published under `ghcr.io/atticplaygroup/paid-services/`. Existing release image tags cause the workflow to fail rather than overwrite them.

After all images publish, the workflow checks their registry manifests and packages the production charts. Chart versions omit the `v` (`0.1.123`); application versions and image tags retain it (`v0.1.123`). Packages include the matching metering dependency and are published as OCI charts under `ghcr.io/atticplaygroup/paid-services/charts/`.

The current image builds target Linux amd64.

For example:

```bash
helm show chart oci://ghcr.io/atticplaygroup/paid-services/charts/cashier --version 0.1.123
```

Installation still requires the chart's service endpoints, identities, credentials, and other deployment-specific settings.

## Registry settings and authentication

Configure repository Actions variables under **Settings → Secrets and variables → Actions → Variables** on GitHub, or the equivalent Actions settings in other CI platforms.

| Variable | GitHub | Override |
| --- | --- | --- |
| `IMAGE_PREFIX` | The `oci://` path; defaults to `ghcr.io/atticplaygroup/paid-services` | Overwrite with like `registry.example.com/atticplaygroup/paid-services` |
