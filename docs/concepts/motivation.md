# Motivation: why separate the platform?

A traditional platform often operates the whole application: it stores data, chooses moderation rules, recommends content, provides the interface, and controls access. This is convenient, but users and publishers must usually accept the whole bundle. Changing one part can mean leaving their content, audience, or preferred tools behind.

PAID makes those responsibilities separable. Publishers, infrastructure providers, application developers, sponsors, and users can cooperate while retaining different interests and choosing whom to trust. One operator can still perform every role; separation creates the option to replace individual parts.

## Choose the parts that matter to you

For a social application, separation could let users keep following a publisher's content while choosing another interface or recommender. A publisher could retain control over which updates it endorses while allowing multiple providers to serve copies.

| Choice | What separation enables |
| --- | --- |
| Data and interface | Keep accessing published content through a compatible client with the features you prefer |
| Moderation and recommendation | Choose whose selection or ranking of public content you follow |
| Infrastructure | Choose compatible storage or query providers based on price and service quality |
| Privacy | Decide what preferences to share and which application logic to run locally |
| Funding | Choose paid access or an application funded by advertisements, subscriptions, or sponsors |

These choices depend on compatible APIs and accessible data. A different client cannot replace a service if it cannot obtain the data or reproduce the required behavior.

In a typical federated application, choosing an operator means choosing its stack of accounts, storage, and application services. PAID allows those functions to be chosen independently. The approaches can coexist: a federated operator can use PAID infrastructure.

## Give independent providers a reason to serve

Separating services also separates their costs. Storage, bandwidth, and computation need funding even when their operator does not own the application or its audience.

Metered payments let providers earn from the resources they supply. A publisher can focus on creating and maintaining useful data while other parties serve it when they expect sufficient demand. This creates an opportunity for competing providers; it does not guarantee that providers will appear or keep serving every collection.

The end user need not pay directly. An application can pay for the resources it consumes and cover those costs through subscriptions, advertisements, or sponsorship. Users can also pay for access through a client they control. See [Exchange](./exchange.md) for the payment model.

## Make room for new applications

The larger ambition is to let useful data attract services around it, rather than require its publisher to operate a complete closed platform. Compatible interfaces, verifiable publications, and paid access could enable the following:

| Opportunity | What would make it possible |
| --- | --- |
| Competing and cross-application recommenders | Accessible collections and user-controlled preferences that clients can selectively share or process locally |
| Paid API access | Providers exposing compatible, metered interfaces rather than reserving access for one application |
| Bulk replication | Replicate public data easily rather than fighting with crawlers |
| Publishing from modest infrastructure | Separating the publisher's write and moderation work from read traffic served by other providers |
| Market-driven serving | Providers voluntarily serve collections when expected usage revenue covers their costs |
| Disaster recovery by market | Surviving replicas with complete, verifiable, accessible data and a usable restore process |
| Moving hosting without changing identity | Change domain names with reputation retained by pinned identity discovered automatically |

These are opportunities enabled by separation. They depend on implementation and participation: demand may attract replicas, while less popular data may require sponsorship. Other directions like guaranteed retention, recovery, and private publishing still require more study and design.

## Reduce signup requirements

Key-based identities let participants access public services without registering an email address or phone number. Charging for usage makes resource abuse costly without requiring every caller to prove they are human.

Clients can retain their own preferences and history, and decide what to disclose, rather than tie all user state to a platform login. Identity, resource payments, and application permissions need not share one account. This does not replace moderation, eliminate abuse, or make participants anonymous. [Identity](./identity.md) explains how reputation, user state, custody, and access control can be handled separately.

## Decide whether the tradeoffs fit

PAID is most useful when data can be shared and served by multiple parties, and the application can tolerate the delay involved in replication.

- **Control:** once others have copied public data, the publisher cannot reliably recall it or control every presentation of it.
- **Consistency:** replicas can lag behind updates; applications requiring immediate consistency need a different arrangement for those operations.
- **Availability:** replication and competition can improve resilience when providers participate, but the market does not guarantee retention or disaster recovery. Unpopular data may need sponsorship or self-hosting.
- **Trust:** payments and signatures do not guarantee honest service. Clients still choose providers, verify what they can, and accept exposure to parties holding their funds.
- **Responsibility:** publishers still govern their data and mutation APIs; separating read traffic does not remove their moderation or operational duties.

Read [Functionality](./functionality.md) next to see how clients describe what they want independently of a provider. The [video example](./example-video.md) explores how these choices could fit together.
