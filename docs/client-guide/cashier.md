# Cashier

Cashier is the client-side wallet service (or interceptor). You deposit chain funds once. Cashier then buys provider points and mints a request-bound access token so outproxy or your application can call PAID hosts.

Anonymity is not a design goal. Cashier keeps a small set of configured principals and can isolate keys per host. If you need stronger unlinkability, write your own cashier and generate a new principal per provider or even per request.

## What cashier does

A typical funding cycle looks like this:

1. You fund the cashier chain account with SUI.
2. Cashier reads the provider manifest and chooses a compatible exchange.
3. Cashier deposits chain coins to that exchange, buys provider points, and redeems them at the provider account service.
4. For each outbound request, cashier returns a short-lived DPoP Bearer proof bound to that request's method and HTU.

The HTTP surface is `cashier.v1.CashierService`:

| RPC | Purpose |
| --- | --- |
| `GetAccessToken` | Fund the destination if needed, then return a DPoP proof for `htu` + `htm` |
| `GetFunds` | Request SUI from a non-mainnet faucet into the configured mnemonic |
| `GetChainBalance` | Inspect the configured wallet address and native coin balance |

All RPCs require:

- `x-user-id`: the configured account principal, encoded as a CIDv1 public JWK thumbprint as described in [client authentication](./client-auth.md#principal-encoding). Unknown principals return `403`.
- `x-request-id`: a unique request ID for tracking; use a UUID, for example `$(uuidgen)`.

They are compatible if run a public cashier, authenticated with [the general DPoP method](./client-auth.md#authentication). A public cashier is helpful some clients do not want to run their own and trusts your cashier service.

## Run cashier service

### Cashier config

Config example:

```json
{
  "accountSalt": "change-me",
  "defaultChainDepositAmount": 1000000000,
  "defaultProviderDepositAmount": 100000,
  "accounts": [
    {
      "principal": "bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s",
      "masterSecretMnemonic": "legal winner thank year wave sausage worth useful legal winner thank yellow",
      "payments": [
        {
          "paymentCoin": "PAYMENT_COIN_SUI",
          "paymentEnvironment": "PAYMENT_ENVIRONMENT_DEVNET",
          "mnemonic": "test test test test test test test test test test junk"
        }
      ]
    }
  ]
}
```

> [!INFO]
> The example principal is derived from the demo outproxy mnemonic `legal winner thank year wave sausage worth useful legal winner thank yellow` and `cashierAccountSalt: "cashier"`. For your own identity, compute the principal in `applications/outproxy`:
>
> ```bash
> export DPOP_MASTER_SECRET='YOUR_BIP39_MNEMONIC'
> export CASHIER_ACCOUNT_SALT='YOUR_CASHIER_ACCOUNT_SALT'
> bun -e '
> import { deriveCashierPrincipal } from "./src/identity.ts"
> console.log(await deriveCashierPrincipal(process.env.DPOP_MASTER_SECRET, process.env.CASHIER_ACCOUNT_SALT))
> '
> ```
>
> Put the result in the cashier account's `principal` and use it as `x-user-id` for direct cashier calls. Outproxy derives the same value automatically. `CASHIER_ACCOUNT_SALT` controls this internal caller identity; cashier's own `accountSalt` separately controls the provider and exchange keys it derives.

Cashier supports multiple profile. For example you want to access it on mobile, on web, then they can use different profile. This is useful if you want to measure usage. Use `principal` to distinguish them. But the SUI wallet account is only a global shared one.

Install dependencies once, then start the service:

```bash
cd applications/cashier
bun install

export GRPC_PORT=8080
export CASHIER_CONFIG="$(cat /path/to/cashier/config.json)"
bun run start
```

Call faucet:

```bash
curl -sS http://127.0.0.1:8080/cashier.v1.CashierService/GetFunds \
  -H 'content-type: application/json' \
  -H 'x-user-id: bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s' \
  -H "x-request-id: $(uuidgen)" \
  -d '{
    "preferredPaymentCoin": "PAYMENT_COIN_SUI",
    "preferredPaymentEnvironment": "PAYMENT_ENVIRONMENT_DEVNET"
  }'
```

Expected responses:

- `200` and `{"$typeName":"cashier.v1.GetFundsResponse"}`: cashier accepted the principal and reached the faucet
- `401`: missing `x-user-id`
- `400`: missing `x-request-id`
- `403`: unknown principal
- `400` `no matching payment configuration`: the account has no payment method for that coin and environment

## Get an access token

Ask cashier for a proof bound to the exact RPC you will call. Use the provider hostname as it appears on the public internet:

```bash
PROVIDER=https://kvstore.paid-services.com
HTU="$PROVIDER/kvstore.v1.MeteredStorageService/GetCASValue"

curl -sS http://127.0.0.1:8080/cashier.v1.CashierService/GetAccessToken \
  -H 'content-type: application/json' \
  -H 'x-user-id: bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s' \
  -H "x-request-id: $(uuidgen)" \
  -d "{
    \"htu\": \"$HTU\",
    \"htm\": \"POST\",
    \"preferredPaymentCoin\": \"PAYMENT_COIN_SUI\",
    \"preferredPaymentEnvironment\": \"PAYMENT_ENVIRONMENT_DEVNET\"
  }"
```

A successful body is `{"accessToken":"<dpop-jwt>"}`.

The first call can take longer than later calls. Cashier checks provider balance first. If the derived host key already has points, it only mints a proof. Otherwise it:

1. Fetches and verifies `<request-origin>/.well-known/paid_provider_manifest.json`.
2. Deposit at exchange with chain token (SUi) if no exchange balance:
  1. Selects an exchange that matches a configured payment coin and environment, and calls its RPCs at the origin advertised in the manifest (including its scheme and port).
  2. Sends `defaultChainDepositAmount` MIST to the exchange deposit address.
4. Calls `exchange.v1.ExchangeService/BuyPoints` to buy points.
5. Redeems the points at `account.v1.AccountService/DepositOrCreateAccount`.

All proofs derive from the cashier account, so the provider sees a stable principal for that cashier. If you want a derivation, change `accountSalt`.

## Inspect the chain address

Call `GetChainBalance` to inspect the authenticated account's wallet for the selected payment configuration. It returns the SUI `address` and native coin `balance` as a decimal string in MIST (1 SUI = 1,000,000,000 MIST). This call does not request faucet funding.

```bash
curl -sS http://localhost:8080/cashier.v1.CashierService/GetChainBalance \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s' \
  -H "x-request-id: $(uuidgen)" \
  -d '{"preferredPaymentCoin":"PAYMENT_COIN_SUI","preferredPaymentEnvironment":"PAYMENT_ENVIRONMENT_DEVNET"}'
```

Deposit SUI to the returned address on the selected network. On demo networks, you can also call `GetFunds` to call faucet, then inspect the balance again.

For library use, import `Cashier` from `src/lib.ts` and call `cashier.getChainBalance(request, principal)`. It returns `{ address, balance }`; use `BigInt(balance)` for arithmetic.


## Library use

Same as outproxy, you may embed the cashier in your typescript code. Import `Cashier` and call `getAccessToken()` will work. Import the lib.ts for it.

### Lazy faucet funding

Set `autoFaucet: true` on a payment configuration to let cashier request faucet SUI when the wallet cannot cover the exchange deposit plus a gas reserve. It defaults to false and is ignored on mainnet. Funding happens during `GetAccessToken`, only when existing provider and exchange balances cannot pay. Cashier shares concurrent wallet funding attempts and waits up to thirty seconds for faucet funding to become visible. Faucet errors or timeouts fail the current request; a later request checks the balance again. The quickstart chart enables this with `cashier.autoFaucet: true`.
