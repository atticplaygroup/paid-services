FROM golang:1.26-bookworm AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY infrastructure/cmd/s3-retention/ ./infrastructure/cmd/s3-retention/
RUN CGO_ENABLED=0 go build -trimpath -o /s3-retention-rules ./infrastructure/cmd/s3-retention

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /s3-retention-rules /s3-retention-rules
USER 65532:65532
ENTRYPOINT ["/s3-retention-rules"]
