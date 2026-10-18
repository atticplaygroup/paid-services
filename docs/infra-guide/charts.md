# Charts

We provide helm charts for party configurations. Currently only kvstore is provided as an example. More to be added soon.

## Cashier

- `charts/cashier/`: Lazy funding service returning DPoP access tokens.

## Exchange

- `charts/exchange/`: PAID usage token exchange backed by its account database.

## User

A user may be an end user who runs docker pull or browser accessing a web page, or any other applications that requests for services like an OCI gateway getting files from an s3 backend.
A user will typically pay for the usage of the requested service.

A user may run the following software components:
- Frontend: The UI the users interacts with.
- Accountant: Progressively spend on-chain funds to exchanges and applications.
- Router: Proxy requests to an appropriate service provider.

## Storage and cache (kvstore)

Storage provider runs:
- Gateway: Envoy with authz-http to authenticate user (but called authz because it uses ext_authz).
- Account: Accepts quota token issued by exchanges to deposit.
- Meter: Measure account usage for key-value storage and retrieval.
- Deduction: Deduct for the request for all its usage.

Storage has fine grained control.
- Storage is metered by space occupied and TTL.
- Retrieval is metered by access count, egress, temporary memory usage etc.

## Computation-intensive resources

DB provider runs:
- Gateway, Account, Deduction: Same as above.

Deduction only meters duration and egress to deduct the request because computation time is a good measure for computation intensive resources like an OLTP relational database or search engine.
(TODO: Review this claim. Any exploits to abuse this metering strategy?)

## Application provider

- Gateway, Account, Deduction: Same as above.
- An application specific meter.

For example, an OCI application with PAID s3 storage backend will use upstream s3 storage prices to deduct requests.
When service accesses are chained, applications may include the cost of this request recursively in HTTP trailers.
Unfortunately mTLS access won't be supported to reflect exact nested usage because general TCP connection cannot express this metadata.

We may have 2 authentications needed in an applications app.
- Incoming authentication: As a server checks requests by users
- Outgoing authentication: As a client to use upstream resources provided by other parties.

## Exchange

- Gateway, Account, Deduction: Same as above.
- Exchange: The exchange logic.

But exchanges will use relational DB as source for account balances to be consistent with external deposit and withdrawals. 

## Proposer

Depending on business requirements, proposer architecture can vary a lot. See below example for discussion.
