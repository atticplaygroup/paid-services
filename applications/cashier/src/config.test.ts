import { describe, expect, it } from "bun:test"
import { parseCashierConfig } from "./config.js"
import { PaymentCoin, PaymentEnvironment } from "./proto/gen/es/exchange/v1/exchange_pb.js"

describe("parseCashierConfig", () => {
  it("parses named payment enums", () => {
    const config = parseCashierConfig(JSON.stringify({
      accounts: [{
        principal: "bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s",
        masterSecretMnemonic: "legal winner thank year wave sausage worth useful legal winner thank yellow",
        payments: [{
          paymentCoin: "PAYMENT_COIN_SUI",
          paymentEnvironment: "PAYMENT_ENVIRONMENT_DEVNET",
          autoFaucet: true,
          mnemonic: "test test test test test test test test test test test junk",
        }],
      }],
      accountSalt: "salt",
      defaultChainDepositAmount: "123",
      defaultProviderDepositAmount: 456,
      accountOriginOverrides: { "provider.example": "https://accounts.example" },
      manifestOriginOverrides: { "provider.example:8443": "https://manifest.example" },
    }))
    expect(config.accounts[0].payments[0].paymentCoin).toBe(PaymentCoin.SUI)
    expect(config.accounts[0].payments[0].paymentEnvironment).toBe(PaymentEnvironment.DEVNET)
    expect(config.accounts[0].payments[0].autoFaucet).toBe(true)
    expect(config.defaultChainDepositAmount).toBe(123n)
    expect(config.defaultProviderDepositAmount).toBe(456n)
    expect(config.accountOriginOverrides).toEqual({ "provider.example": "https://accounts.example" })
    expect(config.manifestOriginOverrides).toEqual({ "provider.example:8443": "https://manifest.example" })
  })
})
