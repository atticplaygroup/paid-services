import * as dpop from "dpop"

export interface AccessTokenRequest {
  url: string
  method: string
  headers: Headers
}

export interface AccessTokenProvider {
  getAccessToken(request: AccessTokenRequest): Promise<string>
}

export class AccessTokenError extends Error {}

export class DirectAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly keypair: dpop.KeyPair) {}

  getAccessToken({ url, method }: AccessTokenRequest): Promise<string> {
    const htu = new URL(url)
    htu.search = ""
    htu.hash = ""
    return dpop.generateProof(this.keypair, htu.href.replace(/\/$/, ""), method)
  }
}

export class CashierAccessTokenProvider implements AccessTokenProvider {
  constructor(
    private readonly address: string,
    private readonly principal: string,
    private readonly doFetch: typeof fetch,
  ) {}

  async getAccessToken({ url, method, headers }: AccessTokenRequest): Promise<string> {
    const cashierHeaders = new Headers({
      "Content-Type": "application/json",
      "x-user-id": this.principal,
      "x-request-id": headers.get("x-request-id") ?? crypto.randomUUID(),
    })
    const externalRequestId = headers.get("x-external-request-id")
    if (externalRequestId) cashierHeaders.set("x-external-request-id", externalRequestId)

    try {
      const response = await this.doFetch(new URL("/cashier.v1.CashierService/GetAccessToken", this.address), {
        method: "POST",
        headers: cashierHeaders,
        body: JSON.stringify({ htu: url.split("?")[0], htm: method, preferredPaymentCoin: 1, preferredPaymentEnvironment: 2 }),
      })
      if (!response.ok) throw new AccessTokenError(`Cashier access token request failed: ${response.status}`)
      const payload = await response.json() as { accessToken?: string }
      if (!payload.accessToken) throw new AccessTokenError("Cashier returned no access token")
      return payload.accessToken
    } catch (error) {
      if (error instanceof AccessTokenError) throw error
      console.error("cashier error:", error)
      throw new AccessTokenError("Bad Gateway: cashier unavailable", { cause: error })
    }
  }
}
