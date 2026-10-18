# Proposer: define what others serve

A proposer defines a functionality and publishes the data needed to serve it. It provides a source of truth that providers can follow, without requiring the proposer to operate every service that delivers the data to users.

For a video collection, the proposer decides which videos belong in the collection and maintains their metadata. Storage and query providers can serve copies of those publications. A proposer can also operate those providers itself.

## Govern the data

The proposer controls its publication process: accepting submissions, moderating content, applying updates, and deciding what to endorse. Those decisions are application-specific. PAID does not prescribe one moderation policy or require the proposer's users to adopt payment keys as their application accounts.

> [!INFO]
>
> For example, a blog may retain conventional login and write APIs while publishing data for independent read providers. Its user-account recovery and rotation remain responsibilities of its application identity system. See [Identity](./identity.md) for the separation from service-payment keys.

Publishing public data also permits others to copy it. Removing an item from a later publication does not recall copies already held elsewhere.

## Publish data that can be checked

Providers and readers need to identify which data the proposer endorsed. Content hashes identify particular bytes; signatures identify the key endorsing a publication. The proposer's public key is the trust anchor for checking signed publications.

Two common publication patterns are:

| Data | Publication pattern |
| --- | --- |
| Objects, such as images and videos | Publish content-addressed objects and signed references through an OCI-compatible workflow |
| Indexed data, such as a relational database | Publish backups and updates that providers can restore into read replicas |

A signature establishes endorsement, not that the data is accurate or valuable. Readers still decide which proposer to follow. Replicas can also lag behind updates; the SLA for revision or freshness belongs in the [functionality](./functionality.md).

## Arrange for serving

A proposer can push objects to a paid store or make publications available for providers to replicate. Providers decide whether to serve them based on demand, costs, and their own policies.

Popular collections may attract providers willing to earn from reads. Less popular collections may require the proposer or a sponsor to fund storage and serving. Publication alone is not a retention or availability guarantee.

For resources requiring a dedicated deployment, such as a database replica, the proposer and provider also need an agreement about what to run. [Service governance](./infrastructure.md#service-governance) describes this relationship.

Publication does not automatically pay the proposer. Usage revenue goes to providers delivering the content; the proposer needs its own business model, such as sponsorship, paid application features, or operating services itself.

Read [Infrastructure](./infrastructure.md) next to understand how providers turn published data into metered services. The [proposer guide](../proposer-guide/getting-started.md) introduces publication workflows.

<!--
## Advertising at an index

(TODO after routing is done)
-->
