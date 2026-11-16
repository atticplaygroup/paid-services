FROM node:22-bookworm-slim
COPY --from=oven/bun:1.4.2-debian /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/testing/realworld-papp
COPY testing/realworld-papp/package.json testing/realworld-papp/bun.lock ./
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
WORKDIR /app/applications/ipfs
COPY applications/ipfs/package.json applications/ipfs/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/ipfs/src ./src
WORKDIR /app/applications/papp-sdk
COPY applications/papp-sdk/package.json applications/papp-sdk/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/papp-sdk/src ./src
WORKDIR /app/applications/papp-gateway
COPY applications/papp-gateway/package.json applications/papp-gateway/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/papp-gateway/src ./src
WORKDIR /app/applications/user-server
COPY applications/user-server/package.json applications/user-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/user-server/src ./src
WORKDIR /app/examples/realworld-papp/frontend
COPY examples/realworld-papp/baseapp ./../baseapp
COPY examples/realworld-papp/frontend/package.json examples/realworld-papp/frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY examples/realworld-papp/frontend ./
RUN bun run build
WORKDIR /app/examples/realworld-papp/baseapp
COPY examples/realworld-papp/baseapp/package.json examples/realworld-papp/baseapp/bun.lock ./
RUN bun install --frozen-lockfile
COPY examples/realworld-papp/baseapp ./
RUN NEXT_TELEMETRY_DISABLED=1 bun run build
WORKDIR /app
COPY proposer/app-packer ./proposer/app-packer
COPY testing/package.json testing/bun.lock ./testing/
RUN cd testing && bun install --frozen-lockfile
COPY testing/routing/helpers.ts testing/routing/scoring.json ./testing/routing/
COPY testing/quickstart/chart/files/prepare-values.mjs ./testing/quickstart/chart/files/prepare-values.mjs
COPY testing/papp/package.json testing/papp/bun.lock ./testing/papp/
RUN cd testing/papp && bun install --frozen-lockfile
COPY testing/papp/gateway-fixture.ts testing/papp/kubo.ts testing/papp/browsers.ts ./testing/papp/
COPY testing/shared ./testing/shared
COPY testing/realworld-papp ./testing/realworld-papp
COPY --from=ipfs/kubo:v0.38.2 /usr/local/bin/ipfs /usr/local/bin/ipfs
CMD ["bun", "test", "--timeout", "3600000", "testing/realworld-papp/e2e-realworld-papp.test.ts", "testing/realworld-papp/upstream-pagination.test.ts"]
