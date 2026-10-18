#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
CI_EMPTY_WALLET=true bash testing/quickstart/quickstart-kind.sh --set-string proxy.cashier.defaultProviderDepositAmount=100000 "$@"
bash testing/quickstart/quickstart-empty-wallet.sh
