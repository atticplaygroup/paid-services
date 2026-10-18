# Identity: keys, accounts, and permissions

A PAID identity is anchored in a public key. A participant proves possession of the corresponding private key when making a request or signing a publication. The public key identifies the participant; it does not establish a real-world name, reputation, or entitlement to every resource.

A participant can create a key without registering an email address or phone number. An application built on PAID may still use conventional accounts for its own users and business rules.

## Separate the responsibilities of an account

Traditional products often use one account for several purposes. PAID allows these responsibilities to be handled separately:

| Responsibility | How it can be handled |
| --- | --- |
| **Reputation and abuse prevention** | Usage charges make resource consumption costly; moderation and reputation address behavior that payment alone cannot resolve |
| **User state** | Clients can retain preferences and history locally, sharing selected information with applications or recommenders |
| **Asset custody** | Wallets, cashiers, exchanges, and providers hold or manage funds and usage balances under separate trust relationships |
| **Access control** | Key ownership and resource-specific rules determine who may publish, change, or access protected resources |

Generating another key is easy. A key therefore proves continuity of identity, not that its holder is a unique human or a trustworthy party. Metered infrastructure charges for resource consumption regardless of how many identities a caller creates. Unpaid bootstrap endpoints require separate abuse protection, such as WAF controls or proof of work.

## Authentication and authorization

**Authentication** establishes which key is acting. PAID clients use a short-lived proof bound to the request's method and URL. A proposer can sign data so readers can check which key endorsed it.

**Authorization** determines whether that identity may perform the operation. For public metered reads, sufficient provider points enable paid usage. Publishing or changing protected data can require additional permissions. Paying for a request does not give the caller ownership of another proposer's data.

Funding operations need a way to bootstrap an identity that has no points yet. Providers can allow authenticated deposits without requiring an existing usage balance. See [client authentication and authorization](../client-guide/client-auth.md) for proof formats, principal encoding, and bootstrap endpoints.

## Keep customer and provider identities separate

When providers call each other, two identities may be involved:

- **Customer identity:** the user calling the application, evaluated within a provider's trust boundary.
- **Provider identity:** the provider's identity when it calls others.

For example, a video website may recognize a viewer through its own account system while paying a storage provider under the website's service identity. Costs can cascade across providers. The storage provider charges that website's provider identity. Customer identity headers stay within the application party; they are not credentials to forward to another provider.

Outproxy and cashier implement this separation. Outproxy attaches the service proof, while cashier manages funding and produces proofs in cashier mode. An application can also obtain and attach proofs directly. See the [outproxy](../client-guide/outproxy.md) and [cashier](../client-guide/cashier.md) guides for setup.

## Choose what to entrust and disclose

Using different keys for different providers can reduce direct linkage between accounts. Anonymity is not a design goal. Network activity, payments, and application data can still connect them. A cashier or proxy entrusted with keys and funds is also part of the participant's trust boundary.

Service-payment keys used by outproxy have no recovery or rotation mechanism. If a key is compromised, treat it and its associated funds as permanently lost. Deposit only enough for near-term usage to limit exposure.

User identities at a proposer, such as accounts used for submissions and moderation, are managed separately. Recovery and rotation follow the application's identity system, such as OIDC, rather than the outproxy payment-key model. An application may instead choose a key-based model like Nostr; those keys still belong to a different layer from PAID service-payment keys.

Public access also means an ACL alone cannot protect data already copied by an untrusted provider. Encryption can restrict who reads the plaintext, but cannot recall plaintext that a recipient has already obtained.

Read [Exchange](./exchange.md) next for how funds become provider points.
