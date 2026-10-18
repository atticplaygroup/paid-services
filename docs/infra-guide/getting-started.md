# Infrastructure operator guide

Do you have idle resources like CPU, storage or network bandwidth? You can share it for money by becoming an infrastructure provider. You can serve s3, database, search engine for various applications. People access them and pay you for the serving. What's more, you do not need to collect data yourself, which saves you cost to manage businesses. You will be like a SaaS provider but <!-- TODO: write some benefits -->. For more on how an infrastructure operator does, see [concepts](../concepts/infrastructure.md). This guide will guide you on how to operate as an infrastructure operator.

Infrastructure operators pull or receive data from proposers, advertise themselves at an index that they provide some Functionality to be discovered by users and earn money.

## Before you begin

- Decide what you want to serve
  - Resource
    - If your bandwidth and storage is cheap, serve blobs
    - If your CPU is cheap, serve database
  - Data
    - Choose popular data
      - (TODO: Aggregated statistics by routers)
      - (TODO: Feasibility study of auction based data distribution)
    - Consider geographical preference of users
- Decide where to serve
  - On cloud
    - Scalable
    - Elastic
    - Predictable cost
  - On premise
    - Low cost
    - Autonomous

## Deploy cluster

Deploying a PAID service is easy. We support HTTP based services because we use the HTTP based [authentication](../client-guide/client-auth.md).

Depending on SLA requirement in the `variant` of the functionality, you may consider using different backend to run them. For low latency high availability resource requirements, you may choose cloud providers. Otherwise using your laptop to serve small traffic makes you more competitive too.

We focus to support GitOps as the main deployment option. You first need a k8s cluster. You define the total resource for it. Then run the helm charts under `charts/` to deploy, with custom values fitting your environment. Check infrastructure/example-deployments for example kustomizations to deploy exchange, storage, database replica, and OCI wrapper application.

<!-- TODO: provide examples in flux under infrastructure/example-deployments. -->

Each chart contains a meter subchart with account, authz and deduction Deployments. Typical topology is:

- Envoy gateway
- Meter services
  - account
  - authz
  - deduction
- Payload services (optionally choose some)
  - exchange
  - kvstore
  - mysql-replica
  - Application services
    - oci

For more details, read on their user guide and chart READMEs.

<!-- 
## Service governance - choosing what to deploy

~~Just find yourself. Find what makes you earn more.~~

Heuristically you want to serve when your resource is cheap, with high demand low supply functionalities in your geographical region. How do you know? It's your business. We have a hypothesis that a global auction based mechanism may exist that encourages such information exchange like a prediction market. But still need more analysis on its properties to maximize social welfare fairness etc. Still, even with it, you may have your own interest deviating a market one. Just serve it. If your users come, it is fine.

-->

## Register yourself to a routing index

<!-- TODO: after routing implemented -->

<!-- 
## Maintain a good reputation

Stick to the SLA requirement defined by a functionality will earn you good reputation. So proposers and users are more willing to deal with you.

Well, that was in theory. It is hard to design how to enforce it by reporting when some service misbehaving, resolving disputes etc. The strategies will evolve in defense and attacks.
-->
