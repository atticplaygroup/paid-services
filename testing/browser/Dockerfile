FROM oven/bun:1.4.2-debian
WORKDIR /app/testing/browser
COPY testing/browser/package.json testing/browser/bun.lock ./
RUN bun install --frozen-lockfile && bunx playwright install --with-deps chromium
WORKDIR /app/applications/oci
COPY applications/oci/package.json applications/oci/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/oci/src ./src
WORKDIR /app/applications/router
COPY applications/router/package.json applications/router/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/router/src ./src
WORKDIR /app/applications/client-auth
COPY applications/client-auth/package.json applications/client-auth/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/client-auth/src ./src
WORKDIR /app/examples/echo-server
COPY examples/echo-server/package.json examples/echo-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY examples/echo-server ./
WORKDIR /app
COPY proposer/app-packer ./proposer/app-packer
COPY testing/routing/helpers.ts testing/routing/scoring.json ./testing/routing/
# helpers resolves its dependencies from /app/testing.
COPY testing/package.json testing/bun.lock ./testing/
RUN cd testing && bun install --frozen-lockfile
COPY testing/browser ./testing/browser
RUN bun test proposer/app-packer testing/browser/client-auth.test.ts
CMD ["bun", "test", "testing/browser/e2e-browser.test.ts"]
