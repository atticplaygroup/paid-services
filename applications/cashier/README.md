# Cashier

Cashier funds a service provider lazily and returns a bound DPoP proof JWT.

## Usage
- The TypeScript class `Cashier` is the client library.
- The standalone service is the trusted-mode outproxy backend.
- It reads `x-user-id` and only accepts principals configured in `CASHIER_ACCOUNTS`.

## Configuration
See `.env.example`. Payment configuration is selected by coin and environment.
The SUI mnemonic is used for chain payments and faucet requests. The account
master secret is used only to derive deterministic per-host DPoP keys.
