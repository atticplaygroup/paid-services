FROM oven/bun:1.4.2-alpine
WORKDIR /app/applications/client-auth
COPY applications/client-auth/package.json applications/client-auth/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/client-auth/src ./src
WORKDIR /app/applications/outproxy
COPY applications/outproxy/package.json applications/outproxy/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/outproxy/ .
RUN bun run build
EXPOSE 9090
ENTRYPOINT ["bun", "run", "dist/server.js"]
