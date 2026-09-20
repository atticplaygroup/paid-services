import { describe, expect, it } from "bun:test"
import { loadCashierConfig } from "./config.js"
import { PaymentCoin, PaymentEnvironment } from "./proto/gen/es/exchange/v1/exchange_pb.js"

describe("loadCashierConfig", () => {
  it("parses named payment enums", () => {
    const config = loadCashierConfig({
      CASHIER_ACCOUNTS: JSON.stringify([{
        principal: "alice",
        masterSecretHex: "00",
        payments: [{
          paymentCoin: "PAYMENT_COIN_SUI",
          paymentEnvironment: "PAYMENT_ENVIRONMENT_DEVNET",
          mnemonic: "test test test test test test test test test test test junk",
        }],
      }]),
    })
    expect(config.accounts[0].payments[0].paymentCoin).toBe(PaymentCoin.SUI)
    expect(config.accounts[0].payments[0].paymentEnvironment).toBe(PaymentEnvironment.DEVNET)
  })
})
