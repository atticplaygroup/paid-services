import { Cashier } from "./cashier.js"
import type { CashierConfig, PaymentConfig } from "./config.js"
import type { AccessTokenProvider, AccessTokenRequest } from "../../client-auth/src/access-token.js"

/** Keep the wallet and master secret in the browser; only proofs leave this adapter. */
export class BrowserCashierAccessTokenProvider implements AccessTokenProvider {
  readonly #cashier: Cashier
  // Funding the same wallet concurrently can race on chain coin selection.
  #pending: Promise<unknown> = Promise.resolve()

  constructor(
    config: CashierConfig,
    private readonly principal: string,
    private readonly payment: Pick<PaymentConfig, "paymentCoin" | "paymentEnvironment">,
    fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.#cashier = new Cashier(config, { fetch: fetcher })
  }

  getAccessToken(request: AccessTokenRequest): Promise<string> {
    const next = this.#pending.catch(() => {}).then(async () => {
      const response = await this.#cashier.getAccessToken({
        htu: request.url,
        htm: request.method,
        preferredPaymentCoin: this.payment.paymentCoin,
        preferredPaymentEnvironment: this.payment.paymentEnvironment,
      }, this.principal)
      return response.accessToken
    })
    this.#pending = next
    return next
  }
}
