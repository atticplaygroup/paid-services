# Functionality: describe the service you want

A functionality describes what a client wants a service to do, independently of who operates it. Several providers can offer the same functionality, letting clients choose between them without changing what they ask for.

For example, a client might want to play videos from a particular publisher's collection. The publisher defines the collection, while different providers can store and deliver those videos. Choosing another provider should preserve the client's access to that collection.

## Behavior and variant

A functionality has two parts:

| Part | What it describes | Video service example |
| --- | --- | --- |
| **Behavior** | The API and the meaning of its operations | List videos, fetch their metadata, and download video segments |
| **Variant** | The data and service requirements that specialize that behavior | Serve a particular publisher's collection, with a specified freshness and delivery quality |

Behavior tells a client how to interact with the service and what the responses mean. Matching endpoint names alone is insufficient: providers must agree on the meaning of requests and responses for clients to use them interchangeably.

A variant narrows that behavior to the service the client actually wants. Two services can implement the same video API while offering different collections. They share a behavior but have different variants.

Variants can also describe geographic requirements and other service-level requirements, such as availability, throughput, latency, and freshness. These attributes express expectations; declaring them does not enforce them.

## A concrete example

Suppose a publisher, acting as a [proposer](./proposer.md), maintains a public video collection. A functionality for viewing it could specify:

- **Behavior:** an API for listing videos, fetching metadata, and downloading segments.
- **Data requirement:** serve the collection defined by that proposer's signed publications.
- **Freshness requirement:** reflect changes to the collection within one hour.
- **Quality requirement:** offer 99.9% availability and at least 10 MB/s download throughput for AWS US East machines.
- **Validity period:** the requirements apply until a specified date and time, including its time zone.

These are illustrative requirements, not guarantees supplied by PAID itself. A usable quality requirement also needs measurement conditions, such as the observation period and where measurements are taken.

Two providers might both claim to meet this functionality while charging different prices or operating in different regions. A client can choose either, provided it can use the same API and obtain the required data and service quality. A provider serving a different collection would not meet the same variant, even if its API were identical.

## A definition does not guarantee delivery

A functionality gives clients an expectation against which to evaluate a provider. It does not make the provider trustworthy or enforce its promises.

Some dimensions for clients to evaluate providers:

- **Honesty:** does the provider behave as claimed, or deliberately return misleading results? A previously honest provider can still misbehave later.
- **Quality:** does it meet the stated service levels? Geography, network conditions, peak hours, and load affect latency, throughput, and availability, even when a provider acts honestly.
- **Data:** does it serve the required collection, with the expected completeness and freshness? Providers implementing the same API may hold different data.

Where data is content-addressed or signed, clients can check its integrity or origin. Those checks alone do not establish completeness, freshness, availability, or compliance with other service requirements.

Clients still need to decide which providers to trust and whether their service meets the stated requirements. Reputation and independent measurements can inform that decision, but past performance cannot guarantee future behavior.

Read [Proposer](./proposer.md) next to understand who defines the data others serve. [Routing](./routing.md) describes the approach to finding and selecting providers for a functionality.
