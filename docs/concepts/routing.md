# Routing: find and choose a provider

Routing connects a client's requested [functionality](./functionality.md) to a provider claiming to serve it. The goal is to choose among compatible providers without tying the desired service permanently to one operator or domain.

## How does a user see contents?

- Functionality advertising: User wants to see contents. A website with a human memorizable name, like foo.com, advertises itself that they serve interesting contents. Here serving that type of interesting contents is a functionality. Advertising lets users know this functionality exists, and is worth viewing.
- Functionality discovery: When it gets popular, some behavior proposer will abstract it as behaviors. Some variant proposer will define variants like with different data quality, network conditions. Users can search for functionalities according to its budget and requirements from an index.
- Provider discovery: Many providers will run the functionality to serve users for profit. To select reputable providers, the index will provide some metrics of providers.
- Provider connection: After deciding a provider, we need to connect to it securely. One may have different threat models. For example if you trust public PKIs, you can use normal HTTPS TLS connection. If you do not, you can pin its identity with its self-signed CA matching its principal, libp2p identity, or .onion identities. They can be listed in their connection methods in index.

Functionality advertising in essense is the ownership of an NFT, associating a human memorizable string to a functionality. This is out of the scope of routing. Routing solves the other 3 layers of problems:
- Functionality discovery
- Provider discovery
- Provider connection

The routing is consist of 2 parts
- Index: runs as a PAID service. It aggregates information like the lists of variants, provider reputation and connection methods. They also provide a ranking.
- Router: runs at client side. It select Indicies the client trusts, and adjusts rankings from Indices.

The implementation of router can be as libraries, service worker, proxy. The concept is above. It does not necessarily intercept https://paid.invalid. Below are some agent generated garbage docs. You can view as reference.

## Functionality discovery

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

The routing index lists provider advertisements by exact behavior and variant identity. Providers sign their advertisements, and indices supply scores for requested scoring functionalities. The client configures the indices it trusts; discovery cannot bootstrap from no information at all. Scores are index annotations, separate from the publisher's signed claims.

The router queries those indices and checks functionality matching, provider origins, required principals, and advertisement expiry before selection. It deduplicates origins in the selected order and checks expiry again before each forwarding attempt. These checks apply with every ranking rule. Indices also exclude expired advertisements from search.

Variants currently describe expectations. Representing them as searchable key-value attributes is proposed so a client could ask for providers meeting particular requirements. Matching those attributes would identify compatible claims, not enforce or verify them.

A provider's operating region is different from a measurement location. A client might care about throughput from its own region regardless of where the provider operates.

## Provider discovery

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

For example, a viewer wants a particular proposer's video collection through a compatible API, updated within one hour. Several providers may claim to meet that requirement. The viewer could compare prices, measured performance, and data coverage before choosing one.

Selection depends on the client's priorities and trusted information. A cheap nearby provider may suit one client, while another prioritizes completeness or availability. There need not be one globally correct answer or reputation authority.

The router requires an explicit ranking rule; omitting it raises an error. A rule declares which scoring functionalities to request and orders or selects from the router's eligible candidates. The available average-score rule must be chosen in configuration: it averages available configured scores and omits providers without matching scores. Other rules can choose a different order while reusing the router's discovery, validation, expiry checks, and deduplication. The initial index scorer measures advertisement acceptance time; it is not a general measure of service quality.

[Functionality](./functionality.md#a-definition-does-not-guarantee-delivery) describes the honesty, quality, and data dimensions of provider evaluation. Reputation can inform a choice, but past behavior does not guarantee future service. Independent observers and signed response reports are exploratory designs.

## Provider connection

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

Selecting a provider and authenticating the connection are different tasks. Finding an endpoint does not prove that its operator is the intended provider.

Ordinary deployments use DNS and TLS to authenticate domain endpoints. A separate proposed mechanism would bind an endpoint to the provider's public-key identity through a signed challenge. The challenge format, key binding, and verification rules need a protocol design before being presented as an available capability.

Server authentication also differs from client authentication: the former checks whom the client reached, while the latter proves which paying identity is calling. See [Identity](./identity.md).

## Decide where routing runs

> [!WARNING] Agent generated docs
>
> This section is agent-generated and not reviewed. Only use it as a reference. Don't trust it. Your agent may read the code and generate better.

The implemented router runs locally as a fetch interceptor. One interceptor handles all functionalities: ordinary URLs pass through, while requests to `paid.invalid` carry the desired functionality as local request metadata. The router replaces the origin with the selected provider's origin. A delegated routing service would introduce another trust relationship and may learn which functionality a client requests.

Routing preserves the method, headers, path, query, and body. GET and HEAD requests can fail over to another provider; writes are not replayed after being sent. Authentication runs through the wrapped fetch or outproxy after routing, so the request proof is bound to the selected destination and method. Envoy and the meter enforce authentication and paid usage at the provider gateway.

Routing is optional when a client already knows a suitable provider. The [quickstart](../quickstart.md) is the simplest way to try that arrangement; the [video example](./example-video.md) illustrates how discovery could fit into a larger application.
