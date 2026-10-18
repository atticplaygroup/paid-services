#!/usr/bin/env bash
# Run the cashier suite against the quickstart Helm fixture.
set -euo pipefail
cd "$(dirname "$0")/../.."
bun install --cwd applications/cashier --frozen-lockfile
bun install --cwd testing --frozen-lockfile
bun test testing/cashier/e2e-cashier-e2e.test.ts
