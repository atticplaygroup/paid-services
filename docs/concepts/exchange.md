# Exchange: turn funds into paid usage

PAID separates funding from request-level deductions. A caller deposits funds, buys provider points, and spends those points as resources are consumed. This avoids making a blockchain transaction for every request.

## Three payment layers

With the payment layer hierarchy, we aim to provide a high throughput and low cost payments.

| Layer | What it holds | What an operation costs |
| --- | --- | --- |
| Chain | Blockchain assets, currently used through SUI payment flows | A chain transaction, including fees and confirmation time |
| Exchange | Deposited funds available for purchases | An exchange operation, backed by database transactions |
| Provider points | Prepaid usage balance accepted by one provider | A balance update as usage is metered |

An exchange is a custodial service. Depositing there means trusting its operator to maintain balances and honor withdrawals. Blockchain settlement does not make an exchange's internal accounting decentralized.

> [!NOTE]
> 
> This is also why we strongly recommend you to **deposit just enough for what is needed for usage**. For example if you use Cashier to manage a large amount of funds, you are under the risk of some applications costing you a lot of money, or the risk of exchange default. Limit funds to limit the risk exposure. See [identity](./identity.md) on discussion of why we do not support key recovery too.

Provider points are restricted to that provider, associated with their payment coin and environment, and nonrefundable. Points can expire. They are a prepaid resource balance rather than transferable money accepted everywhere.

Exchange, like other provider, has expiration for accounts too. If you do not spend funds on time, they disappear. You can purchase for account TTL to extend them. This is to maintain the autonomy of providers.

## Follow the funding cycle

Suppose a client wants to read from a storage provider:

1. The paying party funds a chain wallet managed by its cashier.
2. Cashier obtains the provider's manifest and selects an exchange compatible with its configured payment method and accepted by the provider.
3. It deposits chain funds at the exchange when necessary.
4. It purchases a usage receipt for that provider and redeems it at the provider's account service to obtain points.
5. Requests consume those points according to the provider's metering and prices.

Cashier automates this process and reuses existing balances before obtaining more funds. A client generally needs neither a chain transaction nor an exchange purchase on each request.

## Providers choose their payment relationships

A provider chooses which exchanges and payment methods it accepts. A caller therefore needs a compatible route from its available funds to that provider's points. There is no requirement for every provider to trust one universal exchange.

The exchange accounts for purchases and the seller's proceeds. Sellers can request withdrawal to a chain address, subject to the exchange's fees and processing rules.

Points, however, is generally not refundable. A provider can expose some API to trade them out to an exchange but it would be another application out of scope here.

Similarly, other extensions are possible. The working demo uses SUI devnet. Additional payment systems, transfers between exchanges, or exchange services for other assets are possible.

Read [Routing](./routing.md) next for provider selection. The [cashier guide](../client-guide/cashier.md) describes client funding, and the [exchange guide](../infra-guide/exchange.md) covers operator topics.
