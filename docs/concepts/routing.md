# Routing: find and choose a provider

Routing connects a client's requested [functionality](./functionality.md) to a provider claiming to serve it. The goal is to choose among compatible providers without tying the desired service permanently to one operator or domain.

The current quickstart uses a known provider. The discovery and selection model described here is a design direction; searchable variants and reputation mechanisms remain under development.

## Discover candidates

A routing index could list providers by behavior and variant, including data identity, revision, freshness, geography, and service-level claims. The client needs an initial index or another discovery source it trusts; discovery cannot bootstrap from no information at all.

Variants currently describe expectations. Representing them as searchable key-value attributes is proposed so a client could ask for providers meeting particular requirements. Matching those attributes would identify compatible claims, not enforce or verify them.

A provider's operating region is different from a measurement location. A client might care about throughput from its own region regardless of where the provider operates.

## Select a provider

For example, a viewer wants a particular proposer's video collection through a compatible API, updated within one hour. Several providers may claim to meet that requirement. The viewer could compare prices, measured performance, and data coverage before choosing one.

Selection depends on the client's priorities and trusted information. A cheap nearby provider may suit one client, while another prioritizes completeness or availability. There need not be one globally correct answer or reputation authority.

[Functionality](./functionality.md#a-definition-does-not-guarantee-delivery) describes the honesty, quality, and data dimensions of provider evaluation. Reputation can inform a choice, but past behavior does not guarantee future service. Independent observers and signed response reports are exploratory designs.

## Connect to the selected identity

Selecting a provider and authenticating the connection are different tasks. Finding an endpoint does not prove that its operator is the intended provider.

Ordinary deployments use DNS and TLS to authenticate domain endpoints. A separate proposed mechanism would bind an endpoint to the provider's public-key identity through a signed challenge. The challenge format, key binding, and verification rules need a protocol design before being presented as an available capability.

Server authentication also differs from client authentication: the former checks whom the client reached, while the latter proves which paying identity is calling. See [Identity](./identity.md).

## Decide where routing runs

Selection could run in a client, middleware, a service worker, or a delegated routing service. A delegated service introduces another trust relationship and may learn which functionality a client requests.

Routing must preserve the intended operation. Redirecting a read is different from retrying a write; method, body, request proof, and retry semantics need explicit handling. A client switching destinations must obtain a proof bound to the selected destination.

Routing is optional when a client already knows a suitable provider. The [quickstart](../quickstart.md) is the simplest way to try that arrangement; the [video example](./example-video.md) illustrates how discovery could fit into a larger application.
