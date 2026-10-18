FROM golang:1.26-bookworm AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY infrastructure/ ./infrastructure/
RUN go build -o /kvstore ./infrastructure/cmd/kvstore && \
    go build -o /deduction ./infrastructure/cmd/deduction && \
    go build -o /authz-http ./infrastructure/cmd/authz-http && \
    go build -o /account ./infrastructure/cmd/account && \
    go build -o /exchange ./infrastructure/cmd/exchange && \
    go build -o /exchange-migrate ./infrastructure/cmd/exchange-migrate

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=builder /kvstore /kvstore
COPY --from=builder /deduction /deduction
COPY --from=builder /authz-http /authz-http
COPY --from=builder /account /account
COPY --from=builder /exchange /exchange
COPY --from=builder /exchange-migrate /exchange-migrate
