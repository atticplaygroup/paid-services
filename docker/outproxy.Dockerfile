FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY applications/outproxy/package.json applications/outproxy/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/outproxy/ .
RUN bun run build
EXPOSE 9090
ENTRYPOINT ["bun", "run", "dist/server.js"]
