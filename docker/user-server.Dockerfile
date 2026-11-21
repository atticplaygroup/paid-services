FROM oven/bun:1.4.2-debian
WORKDIR /app/applications/cashier
COPY applications/cashier/package.json applications/cashier/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/cashier/src ./src
WORKDIR /app/applications/client-auth
COPY applications/client-auth/package.json applications/client-auth/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/client-auth/src ./src
WORKDIR /app/applications/router
COPY applications/router/package.json applications/router/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/router/src ./src
WORKDIR /app/applications/user-server
COPY applications/user-server/package.json applications/user-server/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/user-server/src ./src
CMD ["bun", "src/server.ts"]
