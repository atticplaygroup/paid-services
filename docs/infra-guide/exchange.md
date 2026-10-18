# Exchange

## Deposit

<!-- Deposit steps: Transfer, report to exchange with challenge response based proof, check balance and expiration. You can control expiration with account ttl price -->

<!-- Deposit check internals: SuiDepositProof, challenge-response timeout -->

<!-- Clean expired accounts with PruneAccounts -->

## Buy points

<!-- Jwt format, token timeout -->

<!-- JWT Trust anchor: https domain name. key rotation by standard well-known jwks -->

## Withdrawal

Following successful sales on Exchange, sellers have the option to withdraw their earnings as Sui tokens, with potential support for additional currencies in the future. The design aims to prevent insolvency by ensuring sufficient funds are always available for withdrawals. This requires implementing atomic transactions and collecting fees to cover gas costs and any external charges.

Withdrawals are processed using collected priority fees. A withdrawal transaction is initiated only when the total priority fees collected surpass the gas costs involved. In practice, Exchange operators may enforce a minimum priority fee requirement for withdrawals.

The withdrawal process leverages the [idempotent](https://blocknews.com/sui-ecosystem-an-overview/) nature of Sui transactions. Transactions are sent repeatedly until they are successfully finalized.

> [!CAUTION]
>
> The gas budget of a dispatched transaction never changes.
>
> A transaction may be refused for an extended period if gas prices rise, preventing inclusion in a block. In such cases, Exchange will continue retrying the same transaction until the gas price drops below the original level. And if it doesn't drop, the users may starve for a long time without receiving withdrawal.

When a user initiates a withdrawal request, the corresponding funds are locked. During this period, the user retains the option to cancel the withdrawal.

A scheduled task periodically checks the list of withdrawals in the waiting state, collecting priority fees from highest to lowest. If the collected priority fees exceed the estimated gas cost, the task processes the withdrawals by constructing a Sui transaction that sends funds to the designated addresses. Withdrawal addresses may differ from deposit addresses. Upon processing, the status changes to `processing` and the associated funds in Exchange are burned.

If a periodic check of the blockchain confirms the transaction's success, the withdrawal status will be updated to `succeeded`.

To prevent unbounded database growth, transactions with a `succeeded` status are purged after a specified retention period.

See the withdrawal golang test file for a usage exmaple.
