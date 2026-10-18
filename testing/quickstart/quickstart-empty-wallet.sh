#!/usr/bin/env bash
# Verify the actual cashier wallet before any authorization or seed request.
set -euo pipefail
kubectl -n "${NAMESPACE:-quickstart}" exec "deployment/${RELEASE:-quickstart}" -c cashier -- bun -e '
  import { Cashier, loadCashierConfig } from "./src/lib.ts";
  const config = loadCashierConfig();
  const account = config.accounts[0];
  const payment = account.payments[0];
  if (payment.paymentEnvironment !== 2 || payment.autoFaucet !== true) throw new Error("Expected devnet lazy faucet funding");
  const {address, balance} = await new Cashier(config).getChainBalance({
    preferredPaymentCoin: payment.paymentCoin,
    preferredPaymentEnvironment: payment.paymentEnvironment,
  }, account.principal);
  if (BigInt(balance) !== 0n) throw new Error(`Wallet is not empty: ${balance}`);
  console.log(`Verified empty SUI wallet: ${address}`);
'
