# Proposer tutorial - A PAID blog website

Here we guide you through a RealWorld compatible blog website but fully PAID. All RealWorld APIs are supported. But the proposer and infrastructure providers support only a part of them. The proposer implements write APIs. And (implicitly) outsources serving to infrastructure providers.

## Try it now

<!-- TODO: access the demo, guest read, login and write -->

## Run it yourself

<!-- TODO: Deploy examples/realworld kustomization. and some curls to show it working -->

## Architecture

The design philosophy is similar to Nostr, where users choose their favorite client and the server serves all. Servers run arbitrary read-only SQL constructed by the client. A driver workload will translate HTTP requests to TCP requests for browsers to access databases.

Workloads by parties:
- User browser
  - Read
    - SQL logic construction
    - outproxy but as an interceptor
    - cashier but as a library
    - content addressed access to images and video
  - Write
    - OIDC registration and login
    - Access proposer endpoint to write
- Proposer
  - envoy with jwt_authn to parse and verify OIDC
  - Write API
    - profile
    - articles
    - comments
    - likes
  - mysql-proposer
  - meter chart to meter infrastructure provider access
  - unit price cron job
- Infrastructure
  - mysql-replica
  - mysql-driver: HTTP arbitrary read-only SQL execution
  - meter chart to meter user access
  - unit price cron job
- Others
  - OIDC provider

## Functionality

<!-- TODO: Register the functionality on an index and access with router -->
