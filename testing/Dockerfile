FROM golang:1.26-bookworm AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o /kvstore ./infrastructure/cmd/kvstore && \
    go build -o /als ./infrastructure/cmd/als && \
    go build -o /authz-http ./infrastructure/cmd/authz-http && \
    go build -o /account ./infrastructure/cmd/account && \
    go build -o /exchange ./infrastructure/cmd/exchange && \
    go build -o /exchange-migrate ./infrastructure/cmd/exchange-migrate

FROM golang:1.26-bookworm
RUN apk add --no-cache ca-certificates tzdata
COPY --from=builder /kvstore /kvstore
COPY --from=builder /als /als
COPY --from=builder /authz-http /authz-http
COPY --from=builder /account /account
COPY --from=builder /exchange /exchange
COPY --from=builder /exchange-migrate /exchange-migrate
# ENTRYPOINT ["/kvstore"]
