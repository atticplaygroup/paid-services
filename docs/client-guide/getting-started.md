# PAID Services

> [!NOTE]
> This is the user client getting started guide.
> 
> If you want to run an infrastructure or a proposer, start at [infrastructure getting started](../infrastructure/getting-started.md) or [proposer getting started](../proposer/getting-started.md).

In the [Quickstart](./quickstart) you used a blob storage [functionality](./concepts/functionality) from one of its service providers, and fetched a text file. You did not pay because the demo proxy paid for you and let you use its account. In this getting started guide, you will learn to use PAID services autonomously, by setting up your own proxy and pay with your own SUI wallet. No worry we will still use devnet for demonstration.

## Topology

You will run your own outproxy and cashier. The topology is the same except you will use your own kind cluster.

<!-- TODO: mermaid topology here -->

Deploy the outproxy with cashier k8s:

<!-- TODO: set env variables, disable faucet because we will deposit ourselves. and add commands to kind create cluster, helm install, and how to check container healthiness -->

## Cashier

<!-- TODO: Play around with cashier, inspect balance, check SUI address, deposit some devnet SUI, check balance again -->

<!-- TODO: call faucet externally with another account (but comment that in practice you would use your own SUI wallet to get SUI mainnet), and transfer SUI token to the cashier, observe cashier getChainBalance -->

<!-- Observe balance on exchange -->

## Outproxy

<!-- TODO: call the quickstart storage party with your own cashier and outproxy -->

## Routing
