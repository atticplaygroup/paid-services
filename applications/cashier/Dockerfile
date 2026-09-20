FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY src ./src
ENTRYPOINT ["bun", "run", "src/index.ts"]
