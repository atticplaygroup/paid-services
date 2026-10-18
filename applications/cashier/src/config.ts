import { PaymentCoinSchema, PaymentEnvironmentSchema, type PaymentCoin, type PaymentEnvironment } from "./proto/gen/es/exchange/v1/exchange_pb.js";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export interface PaymentConfig {
  paymentCoin: PaymentCoin
  paymentEnvironment: PaymentEnvironment
  mnemonic: string
  suiRpcUrl?: string
  autoFaucet?: boolean
  suiFaucetUrl?: string
}

export interface AccountConfig {
  principal: string
  masterSecret: Uint8Array
  payments: PaymentConfig[]
}

export interface CashierConfig {
  accounts: AccountConfig[]
  accountSalt: Uint8Array
  defaultChainDepositAmount: bigint
  defaultProviderDepositAmount: bigint
  accountOriginOverrides: Record<string, string>
  manifestOriginOverrides: Record<string, string>
}

const DEFAULT_CHAIN_DEPOSIT_AMOUNT = 100_000_000n
const DEFAULT_PROVIDER_DEPOSIT_AMOUNT = 100_000n

function enumValue(schema: typeof PaymentCoinSchema | typeof PaymentEnvironmentSchema, value: string | number): number {
  if (typeof value === "number") return value
  return schema.values.find((entry) => entry.name === value)?.number ?? Number.NaN
}

export function decodeConfigBytes(name: string, value: string): Uint8Array {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${name} is required`)
  if (/^0x[0-9a-fA-F]+$/.test(normalized)) {
    return Uint8Array.fromHex(normalized.slice(2))
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(normalized)) {
    const padded = normalized.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - normalized.length % 4) % 4)
    return Uint8Array.fromBase64(padded)
  }
  return new TextEncoder().encode(normalized)
}

export function parseCashierConfig(rawConfig: string): CashierConfig {
  type RawPayment = { paymentCoin?: string | number; paymentEnvironment?: string | number; mnemonic?: string; autoFaucet?: boolean; suiRpcUrl?: string; suiFaucetUrl?: string }
  type RawAccount = { principal?: string; masterSecretMnemonic?: string; payments?: RawPayment[] }
  type RawCashierConfig = {
    accounts?: RawAccount[]
    accountSalt?: string
    defaultChainDepositAmount?: string | number
    defaultProviderDepositAmount?: string | number
    accountOriginOverrides?: Record<string, string>
    manifestOriginOverrides?: Record<string, string>
  }
  const config = JSON.parse(rawConfig) as RawCashierConfig
  const rawAccounts = config.accounts
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) throw new Error("accounts must be a non-empty array")
  const accounts = rawAccounts.map((raw) => {
    if (typeof raw.principal !== "string" || raw.principal.length === 0) throw new Error("account.principal is required")
    if (typeof raw.masterSecretMnemonic !== "string" || raw.masterSecretMnemonic.length === 0) throw new Error(`masterSecretMnemonic for ${raw.principal} is required`)
    const normalizedMasterSecretMnemonic = raw.masterSecretMnemonic.normalize("NFKD")
    if (!validateMnemonic(normalizedMasterSecretMnemonic, wordlist)) throw new Error(`invalid masterSecretMnemonic for ${raw.principal}`)
    const masterSecretHasher = new Bun.CryptoHasher("sha256")
    masterSecretHasher.update(new TextEncoder().encode(normalizedMasterSecretMnemonic))
    const masterSecretBytes = new Uint8Array(masterSecretHasher.digest())
    if (!masterSecretBytes || masterSecretBytes.length === 0) throw new Error(`masterSecret for ${raw.principal} is required`)
    const payments = (raw.payments ?? []).map((payment) => {
      if (typeof payment.mnemonic !== "string" || payment.mnemonic.length === 0) throw new Error(`payment mnemonic for ${raw.principal} is required`)
      if (payment.paymentCoin !== undefined && payment.paymentCoin !== "PAYMENT_COIN_SUI" && payment.paymentCoin !== 1) throw new Error(`unsupported paymentCoin for ${raw.principal}`)
      if (payment.paymentEnvironment !== undefined && !["PAYMENT_ENVIRONMENT_MAINNET", "PAYMENT_ENVIRONMENT_DEVNET", "PAYMENT_ENVIRONMENT_TESTNET", "PAYMENT_ENVIRONMENT_LOCALNET", 1, 2, 3, 4].includes(payment.paymentEnvironment)) throw new Error(`unsupported paymentEnvironment for ${raw.principal}`)
      return {
        paymentCoin: enumValue(PaymentCoinSchema, payment.paymentCoin ?? 1),
        paymentEnvironment: enumValue(PaymentEnvironmentSchema, payment.paymentEnvironment ?? 4),
        mnemonic: payment.mnemonic,
        autoFaucet: payment.autoFaucet === true,
        suiRpcUrl: payment.suiRpcUrl,
        suiFaucetUrl: payment.suiFaucetUrl,
      } satisfies PaymentConfig
    })
    return { principal: raw.principal, masterSecret: masterSecretBytes, payments }
  })
  const accountSalt = config.accountSalt ? decodeConfigBytes("accountSalt", config.accountSalt) : new TextEncoder().encode("cashier-account-salt")
  return {
    accounts,
    accountSalt,
    defaultChainDepositAmount: config.defaultChainDepositAmount !== undefined ? BigInt(config.defaultChainDepositAmount) : DEFAULT_CHAIN_DEPOSIT_AMOUNT,
    defaultProviderDepositAmount: config.defaultProviderDepositAmount !== undefined ? BigInt(config.defaultProviderDepositAmount) : DEFAULT_PROVIDER_DEPOSIT_AMOUNT,
    accountOriginOverrides: config.accountOriginOverrides ?? {},
    manifestOriginOverrides: config.manifestOriginOverrides ?? {},
  }
}

export function loadCashierConfig(): CashierConfig {
  const rawConfig = process.env.CASHIER_CONFIG
  if (!rawConfig) throw new Error("CASHIER_CONFIG is required")
  return parseCashierConfig(rawConfig)
}
