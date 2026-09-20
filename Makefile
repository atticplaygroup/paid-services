BUILD_DIR := infrastructure/bin

.PHONY: build build-go build-ts generate test-go test-docker-up test-docker-build

build: build-go

build-go:
	go build -o $(BUILD_DIR)/kvstore ./infrastructure/cmd/kvstore
	go build -o $(BUILD_DIR)/als ./infrastructure/cmd/als
	go build -o $(BUILD_DIR)/account ./infrastructure/cmd/account
	go build -o $(BUILD_DIR)/authz-http ./infrastructure/cmd/authz-http
	go build -o $(BUILD_DIR)/exchange ./infrastructure/cmd/exchange
	go build -o $(BUILD_DIR)/exchange-migrate ./infrastructure/cmd/exchange-migrate
	go build -o $(BUILD_DIR)/toolkit ./infrastructure/cmd/toolkit

build-ts:
	cd applications/cashier && bun run build || echo "bun not available"
	cd applications/oci && bun run build || echo "bun not available"
	cd applications/outproxy && bun run build || echo "bun not available"

generate:
	buf generate

test-go:
	go test ./infrastructure/...
