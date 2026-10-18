FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY applications/cashier/package.json applications/cashier/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/cashier/ .
RUN bun run build

FROM oven/bun:1.4.2
WORKDIR /app
COPY applications/cashier/package.json applications/cashier/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY applications/cashier/src ./src
ENTRYPOINT ["bun", "run", "src/index.ts"]
