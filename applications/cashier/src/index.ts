import { createCashierApp } from "./server.js"

const app = createCashierApp()
const port = Number(process.env["GRPC_PORT"] ?? process.env["PORT"] ?? 8080)
Bun.serve({ port, fetch: app.fetch })
console.log(`cashier listening on :${port}`)
