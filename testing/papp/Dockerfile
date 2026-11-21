FROM node:22-bookworm-slim
COPY --from=oven/bun:1.4.2-debian /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app/testing/papp
COPY testing/papp/package.json testing/papp/bun.lock ./
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
WORKDIR /app
COPY proposer/app-packer ./proposer/app-packer
COPY testing/package.json testing/bun.lock ./testing/
RUN cd testing && bun install --frozen-lockfile
COPY testing/routing/helpers.ts ./testing/routing/helpers.ts
COPY testing/shared ./testing/shared
COPY testing/papp ./testing/papp
COPY --from=ipfs/kubo:v0.38.2 /usr/local/bin/ipfs /usr/local/bin/ipfs
CMD ["bun", "test", "--timeout", "360000", "testing/papp"]
