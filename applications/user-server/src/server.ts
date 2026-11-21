import { createUserServer } from "./lib.ts"
import { parseCashierConfig } from "../../cashier/src/lib.ts"
const config = JSON.parse(process.env.USER_SERVER_CONFIG ?? '{"indices":[],"providerScorings":[],"dailyBudget":"100000"}')
const wallet = process.env.CASHIER_CONFIG_FILE ? parseCashierConfig(await Bun.file(process.env.CASHIER_CONFIG_FILE).text()) : process.env.CASHIER_CONFIG ? parseCashierConfig(process.env.CASHIER_CONFIG) : undefined
const app = createUserServer({ database: process.env.USER_SERVER_DATABASE ?? "user-server.sqlite", config, wallet })
Bun.serve({ hostname: process.env.HOST ?? "0.0.0.0", port: Number(process.env.PORT ?? 3002), fetch: app.fetch, ...(process.env.TLS_CERT && process.env.TLS_KEY ? { tls: { cert: Bun.file(process.env.TLS_CERT), key: Bun.file(process.env.TLS_KEY) } } : {}) })
