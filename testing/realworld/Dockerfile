FROM node:22-bookworm-slim
COPY --from=oven/bun:1.4.2-debian /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/testing/realworld
COPY testing/realworld/package.json testing/realworld/bun.lock ./
RUN bun install --frozen-lockfile && bun x playwright install --with-deps chromium chrome msedge firefox webkit && apt-get update && apt-get install -y --no-install-recommends openssl libnss3-tools && rm -rf /var/lib/apt/lists/*
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
WORKDIR /app/applications/cashier
COPY applications/cashier/package.json applications/cashier/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/cashier/src ./src
WORKDIR /app/applications/papp-sdk
COPY applications/papp-sdk/package.json applications/papp-sdk/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/papp-sdk/src ./src
WORKDIR /app/examples/realworld
COPY examples/realworld/package.json examples/realworld/bun.lock ./
RUN bun install --frozen-lockfile
COPY examples/realworld ./
WORKDIR /app
COPY proposer/app-packer ./proposer/app-packer
COPY testing/package.json testing/bun.lock ./testing/
RUN cd testing && bun install --frozen-lockfile
COPY testing/routing/helpers.ts testing/routing/scoring.json ./testing/routing/
COPY testing/quickstart/chart/files/prepare-values.mjs ./testing/quickstart/chart/files/prepare-values.mjs
COPY testing/shared ./testing/shared
COPY testing/realworld ./testing/realworld
CMD ["bun", "test", "--timeout", "2100000", "testing/realworld/e2e-realworld.test.ts"]
