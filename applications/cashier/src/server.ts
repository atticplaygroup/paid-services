import { Hono } from "hono"
import { PaymentCoinSchema, PaymentEnvironmentSchema } from "./proto/gen/es/exchange/v1/exchange_pb"
import { Cashier, FaucetNotImplementedError } from "./cashier.js"
import { loadCashierConfig, type CashierConfig } from "./config.js"
import type { CashierDeps } from "./cashier.js"

export function createCashierApp(config: CashierConfig = loadCashierConfig(), deps: CashierDeps = {}) {
  const cashier = new Cashier(config, deps)
  const app = new Hono()

  function enumValue(schema: { values: readonly { name: string; number: number }[] }, input: unknown) {
    if (typeof input === "number") return input
    if (typeof input === "string") return schema.values.find((entry) => entry.name === input)?.number ?? Number(input)
    return Number(input ?? 0)
  }

  app.post("/cashier.v1.CashierService/GetAccessToken", async (context) => {
    const principal = context.req.header("x-user-id")
    if (!principal) return context.text("missing x-user-id", 401)
    const requestId = context.req.header("x-request-id")
    if (!requestId) return context.text("missing x-request-id", 400)
    try {
      const body = await context.req.json()
      const response = await cashier.getAccessToken(
        {
          htu: body.htu,
          htm: body.htm,
          preferredPaymentCoin: enumValue(PaymentCoinSchema, body.preferredPaymentCoin),
          preferredPaymentEnvironment: enumValue(PaymentEnvironmentSchema, body.preferredPaymentEnvironment),
        },
        principal,
      )
      return context.json(response)
    } catch (error) {
      console.error("getAccessToken failed:", error)
      if (error instanceof Error && error.message === "unknown principal") return context.text(error.message, 403)
      return context.text(error instanceof Error ? error.message : "bad request", 400)
    }
  })

  app.post("/cashier.v1.CashierService/GetFunds", async (context) => {
    const principal = context.req.header("x-user-id")
    if (!principal) return context.text("missing x-user-id", 401)
    const requestId = context.req.header("x-request-id")
    if (!requestId) return context.text("missing x-request-id", 400)
    try {
      const body = await context.req.json()
      const response = await cashier.getFunds(
        {
          preferredPaymentCoin: enumValue(PaymentCoinSchema, body.preferredPaymentCoin),
          preferredPaymentEnvironment: enumValue(PaymentEnvironmentSchema, body.preferredPaymentEnvironment),
        },
        principal,
      )
      return context.json(response)
    } catch (error) {
      console.error("getFunds failed:", error)
      if (error instanceof Error && error.message === "unknown principal") return context.text(error.message, 403)
      if (error instanceof FaucetNotImplementedError) return context.text(error.message, 501)
      return context.text(error instanceof Error ? error.message : "bad request", 400)
    }
  })

  app.post("/cashier.v1.CashierService/GetChainBalance", async (context) => {
    const principal = context.req.header("x-user-id")
    if (!principal) return context.text("missing x-user-id", 401)
    const requestId = context.req.header("x-request-id")
    if (!requestId) return context.text("missing x-request-id", 400)
    try {
      const body = await context.req.json()
      const response = await cashier.getChainBalance(
        {
          preferredPaymentCoin: enumValue(PaymentCoinSchema, body.preferredPaymentCoin),
          preferredPaymentEnvironment: enumValue(PaymentEnvironmentSchema, body.preferredPaymentEnvironment),
        },
        principal,
      )
      return context.json({ address: response.address, balance: response.balance })
    } catch (error) {
      console.error("getChainBalance failed:", error)
      if (error instanceof Error && error.message === "unknown principal") return context.text(error.message, 403)
      return context.text(error instanceof Error ? error.message : "bad request", 400)
    }
  })

  return app
}
