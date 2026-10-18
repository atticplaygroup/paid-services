# Infrastructure: serve and meter resources

An infrastructure provider supplies resources such as blob storage, databases, caches, or search indexes. It charges for resource usage and can serve data published by proposers without operating their whole application.

A provider chooses what to serve, which exchanges to accept, and how to price its resources. Clients choose whether its data, cost, and service quality meet their needs.

## Separate publishing from serving

For replicated data, writes follow the proposer through _proposer applications_ and providers serve reads through _replica applications_. A proposer publishes objects or database backups and updates; a provider copies them and exposes the appropriate read interface. Replication may originate from the proposer or another replica, after the required publications are cryptographically verified.

Replicas need not be equally current. Providers following the same proposer may hold different revisions or subsets. A client's [functionality](./functionality.md) describes the SLA of data and freshness it requires.

For simple applications like object storage, it can be automated by the infrastructure by accepting paid writes, by uploads with a retention period. In this case the uploader will be the `proposer` because the mutation ownership is tied to its identity. Paying for storage does not authorize changes to another proposer's collection.

## Meter what consumes resources

Metering is the main mechanism to prevent abuse of resources, and ensure fair usage proportional to user spending. Metering relates a request to the resources it consumes. Unit prices convert those measurements into deductions from the caller's provider points.

We implement 2 types of strategies depending on if the resource usage can be inferred from gateway metrics.

| Strategy | What it measures | When it is useful |
| --- | --- | --- |
| Gateway metering | Request count, duration, ingress, and egress | When request-level measurements adequately represent cost |
| Resource-specific metering | Operations or consumption known to the service, such as object size and retention duration | When gateway measurements miss important costs |

The two strategies can be combined. Measurements can be relative rather than exact accounting of every physical cost, but they must represent consumption well enough to resist abuse. For example, request duration alone is not automatically a reliable measure of database CPU use, but can be used to charge users to resist abuse.

Providers can tune unit prices as costs or demand change. But it does not always protect the service completely. Operators define pricing and resource-control policies that keep their services economically sustainable. Autonomous operation requires those policies to cover serving costs or reduce and stop service when they cannot. PAID does not prescribe a universal price-control algorithm.

## Expose usable interfaces

PAID's metered access is HTTP-based. Ordinary HTTP clients can use outproxy to attach payment identity proofs; applications can attach them directly. Compatibility with tools such as ORAS depends on the service exposing the API those tools expect.

Non-HTTP access like `mysql://` and `postgres://` protocols need an HTTP gateway for arbitrary read-only access. Because HTTP authorizor will be used to meter accesses. Another option is to obtain published backups and restore them locally.

The gateway authenticates callers, the account service manages provider points, and metering records usage for deduction. [Identity](./identity.md) explains authentication boundaries; [Exchange](./exchange.md) explains funding.

## Frequently used infrastructure

We introduce some important infrastructure for PAID services.

### Blob storage and OCI

Writing:
- Anyone can write. When you write, you are implicitly a proposer. You sign with your authentication key that you generate.
- Storage will accept when you pay for its storage duration and size.
- Further admission rules may be applied at application layer but is subject to operators.

Reading:
- Supports native tools like `mc` and `oras`.
- All contents SHOULD be verified for the proposer's valid signature. Providers are not trusted.

### Database (MySQL)

Writing:

- The proposer governs the primary database and its mutation APIs. It publishes baseline snapshots and incremental binlogs through OCI storage.
- The proposer can select which schemas to publish. Don't disclose information intended to remain private.

Replication:

- Providers restore a baseline and replay binlogs. They MUST verify publication integrity and proposer endorsement before importing.
- Providers MAY fetch artifacts from other replicas for cascade replication. The functionality defines acceptable replication lag.

Reading:

- Replica applications MUST expose only read access to proposer-controlled data. Operators SHOULD meter and bound query resource consumption.
- Arbitrary read-only SQL access needs a metered HTTP gateway; raw MySQL connections do not support PAID authentication. Readers MAY instead restore downloaded backups locally.

## Service governance

PAID services are designed to support continuous delivery via Flux. An infrastructure provider MAY use a git repository to manage services deployed, where users submit pull requests to serve their functionality, possibly with money. In this way a small unpopular proposer can hold its MySQL service and serve traffic. And for popular proposers, an infrastructure provider will be willing to serve it for profit voluntarily, by creating the pull request itself. Once a pull request is merged, flux will reconcile to deliver the change.

For maximum migration ability, an infrastructure provider MAY publish its flux configuration too. If so, anyone pointing its flux to the git repository will automatically construct a k8s cluster providing exactly same services.

Going further in this direction, the continuously delivered repository could be maintained by an independent party who runs no cluster itself. Providers trusting it can follow its configuration blindly.
