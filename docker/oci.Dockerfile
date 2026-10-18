FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY applications/oci/package.json applications/oci/bun.lock ./
RUN bun install --frozen-lockfile
COPY applications/oci/ .
EXPOSE 3000
ENTRYPOINT ["bun", "run", "src/index.ts"]
