# Application: compose services for users

A PAID application implements business logic and a user experience using services supplied by one or more providers. It can run as a backend, in a client, or as a combination of both.

For a video application, that logic might fetch a collection, request recommendations, and retrieve video segments. The proposer defines the collection; infrastructure providers supply storage and queries; the application decides how to retrieve and present them to the viewer.

## Choose where the logic runs

| Arrangement | Who calls the infrastructure? | Main implication |
| --- | --- | --- |
| Hosted application | The application's backend | The operator manages provider access and can pay on behalf of users |
| Client application | Code running under the user's control (e.g. browser) | The frontend (e.g. browser) chooses providers and manages access directly |
| Mixed application | Both client and backend | Each boundary needs a clear identity and payment responsibility |

Moving logic into a client lets users keep preferences, verification, and payment management under their own control, reducing the need to entrust them to a hosted application. A hosted application can offer convenience. Clients still rely on resource providers for serving and on any exchange or delegated cashier holding their funds.

A user running an application solely for themselves need not charge themselves through an additional meter. Calls to independent providers still authenticate and pay under the appropriate identity.

## Decide who pays

The party calling a provider funds its usage. A hosted website may pay for storage reads and earn through advertisements, subscriptions, or sponsorship. A client application may instead use the user's own cashier and funded identity.

When providers call other providers, costs can cascade. For example, a paid application can incur storage charges while serving its own customer. The storage provider charges the application's outbound identity; the application determines how to charge or otherwise fund its own service. Meter feedback can attribute upstream charges to the application's customer without forwarding that customer's credentials upstream.

**Meter feedback** reports the charges associated with an external request ID. An application can correlate an upstream request with its own customer request and schedule its meter to fetch the upstream feedback after processing. Its meter can then deduct that upstream cost from the customer's application balance, alongside charges for the application's own resources.

Feedback can also propagate through successive providers, supporting cascading charges. This requires configured feedback services and request correlation; it is not automatic for every application. Feedback supports cost attribution, not proof that a provider served correctly.

See [Identity](./identity.md) for the customer/provider boundary and [Exchange](./exchange.md) for the payment model.

## Examples of applications

Applications can provide user-facing products or supporting services. Examples include:

- **Video client or website** retrieves a publisher's collection, obtains recommendations, and plays segments from storage providers.

Some implemented today are below. They can run as independent application if their users trust. Or a user can run them itself, as a service or inside browser as interceptor.

- **Outproxy** attaches authorization to outbound HTTP requests, allowing ordinary blackbox clients to call PAID services. HTTPS interception requires trusting its CA. Or if you put it in your controlled code, you do not need the MITM CA.
- **Cashier** manages funding and produces request-bound proofs. Applications can use it directly instead of sending traffic through a proxy.
- **OCI application** adapts OCI operations to the underlying storage and publication workflow, supporting content-addressed objects and signed publications.

## Separate proposer and replica responsibilities

Depending on whether mutatation is supported, we can categorize applications to 2 categories:

A **proposer application** defines mutation APIs and governs which changes enter its published data. It manages submission permissions, moderation, and private information according to its business rules. Publishing data for independent reads does not transfer those responsibilities to replica operators.

A **replica application** serves reads from that published data. It is responsible for implementing the expected API behavior, following the required data revision or freshness, and metering its resource use. It need not recreate the proposer's login, submission, or moderation workflow.

One deployment can combine both roles, but the distinction lets others serve read traffic without taking authority over the proposer's updates.

The [video example](./example-video.md) illustrates possible choices. Read [Identity](./identity.md) next, or use the [outproxy](../client-guide/outproxy.md) and [cashier](../client-guide/cashier.md) guides to configure access.
