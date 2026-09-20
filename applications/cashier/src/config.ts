import { PaymentCoinSchema, PaymentEnvironmentSchema, type PaymentCoin, type PaymentEnvironment } from "./proto/gen/es/exchange/v1/exchange_pb.js";

export interface PaymentConfig {
  paymentCoin: PaymentCoin
  paymentEnvironment: PaymentEnvironment
  mnemonic: string
  suiRpcUrl?: string
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
  insecure: boolean
  defaultChainDepositAmount: bigint
  defaultProviderDepositAmount: bigint
  accountOriginOverrides: Record<string, string>
  exchangeOriginOverrides: Record<string, string>
}

const DEFAULT_CHAIN_DEPOSIT_AMOUNT = 100_000_000n
const DEFAULT_PROVIDER_DEPOSIT_AMOUNT = 100_000n

function enumValue(schema: typeof PaymentCoinSchema | typeof PaymentEnvironmentSchema, value: string | number): number {
  if (typeof value === "number") return value
  return schema.values.find((entry) => entry.name === value)?.number ?? Number.NaN
}

export function decodeEnvBytes(name: string, value: string): Uint8Array {
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

export function loadCashierConfig(env: Record<string, string | undefined> = process.env): CashierConfig {
  const accountsJson = env["CASHIER_ACCOUNTS"]
  if (!accountsJson) throw new Error("CASHIER_ACCOUNTS is required")
  type RawPayment = { paymentCoin?: string | number; paymentEnvironment?: string | number; mnemonic?: string; suiRpcUrl?: string; suiFaucetUrl?: string }
  type RawAccount = { principal?: string; masterSecret?: string; masterSecretHex?: string; masterSecretBase64?: string; payments?: RawPayment[] }
  const rawAccounts = JSON.parse(accountsJson) as RawAccount[]
  if (!Array.isArray(rawAccounts) || rawAccounts.length === 0) throw new Error("CASHIER_ACCOUNTS must be a non-empty array")
  const accounts = rawAccounts.map((raw) => {
    if (typeof raw.principal !== "string" || raw.principal.length === 0) throw new Error("account.principal is required")
    const masterSecretBytes = raw.masterSecretHex
      ? Uint8Array.fromHex(raw.masterSecretHex)
      : raw.masterSecretBase64
        ? Uint8Array.fromBase64(raw.masterSecretBase64)
        : raw.masterSecret
          ? decodeEnvBytes("masterSecret", raw.masterSecret)
          : undefined
    if (!masterSecretBytes || masterSecretBytes.length === 0) throw new Error(`masterSecret for ${raw.principal} is required`)
    const payments = (raw.payments ?? []).map((payment) => {
      if (typeof payment.mnemonic !== "string" || payment.mnemonic.length === 0) throw new Error(`payment mnemonic for ${raw.principal} is required`)
      if (payment.paymentCoin !== undefined && payment.paymentCoin !== "PAYMENT_COIN_SUI" && payment.paymentCoin !== 1) throw new Error(`unsupported paymentCoin for ${raw.principal}`)
      if (payment.paymentEnvironment !== undefined && !["PAYMENT_ENVIRONMENT_MAINNET", "PAYMENT_ENVIRONMENT_DEVNET", "PAYMENT_ENVIRONMENT_TESTNET", "PAYMENT_ENVIRONMENT_LOCALNET", 1, 2, 3, 4].includes(payment.paymentEnvironment)) throw new Error(`unsupported paymentEnvironment for ${raw.principal}`)
      return {
        paymentCoin: enumValue(PaymentCoinSchema, payment.paymentCoin ?? 1),
        paymentEnvironment: enumValue(PaymentEnvironmentSchema, payment.paymentEnvironment ?? 4),
        mnemonic: payment.mnemonic,
        suiRpcUrl: payment.suiRpcUrl,
        suiFaucetUrl: payment.suiFaucetUrl,
      } satisfies PaymentConfig
    })
    return { principal: raw.principal, masterSecret: masterSecretBytes, payments }
  })
  const accountSalt = env["CASHIER_ACCOUNT_SALT"] ? decodeEnvBytes("CASHIER_ACCOUNT_SALT", env["CASHIER_ACCOUNT_SALT"]) : new TextEncoder().encode("cashier-account-salt")
  return {
    accounts,
    accountSalt,
    insecure: env["CASHIER_INSECURE"] === "true",
    defaultChainDepositAmount: env["CASHIER_DEFAULT_CHAIN_DEPOSIT_AMOUNT"] ? BigInt(env["CASHIER_DEFAULT_CHAIN_DEPOSIT_AMOUNT"]) : DEFAULT_CHAIN_DEPOSIT_AMOUNT,
    defaultProviderDepositAmount: env["CASHIER_DEFAULT_PROVIDER_DEPOSIT_AMOUNT"] ? BigInt(env["CASHIER_DEFAULT_PROVIDER_DEPOSIT_AMOUNT"]) : DEFAULT_PROVIDER_DEPOSIT_AMOUNT,
    accountOriginOverrides: env["CASHIER_ACCOUNT_ORIGIN_OVERRIDES"] ? JSON.parse(env["CASHIER_ACCOUNT_ORIGIN_OVERRIDES"]) as Record<string, string> : {},
    exchangeOriginOverrides: env["CASHIER_EXCHANGE_ORIGIN_OVERRIDES"] ? JSON.parse(env["CASHIER_EXCHANGE_ORIGIN_OVERRIDES"]) as Record<string, string> : {},
  }
}
