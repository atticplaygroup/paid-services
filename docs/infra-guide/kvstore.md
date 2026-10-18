# Key Value Store

The `kvstore` workload is a meter for key-value storage abstraction. It manages storage cost and access cost. It can be used for cache, no-sql databased and blob storage.

## Metering

<!-- Model: for horizontally scaled on-demand storage, with unit cost foreseeable in the following period of time. -->

<!-- Goal: 
  - Autonomous: With dynamic unit price control, the metering service will never run out of money, where cost > profit
  - Fairness: The more you pay, the more you get.
-->

<!-- Write metering based on storage bytes and duration, ingress bytes etc. -->

<!-- Read metering based on access request count, egress bytes etc. -->

<!-- Unit price controlling -->

## Access control

<!-- AUTHORIZATION_MODE -->

<!-- CAS and value anchor -->

## OCI usage

<!-- Usage with OCI and ORAS -->
