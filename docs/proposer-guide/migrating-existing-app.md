# Application

## Should I migrate my application to a PAID one?

To migrate as a PAID application, your application must satisfy:
- Data is public or has a part that can be made public, and impossible to revoke
- Accepts eventual consistency and minute level latency

Migration has the following benefits for you to make a decision:
- Better user experience: Bring-your-own-client allows users to use their favorite client and feed recommender.
- Serving operation cost outsourced: You no longer maintain a k8s cluster to scale with traffic. Market scales automatically.
- Low resource requirement: You only need to serve write requests asynchronously. You can do it on your laptop (cheaper egress) or behind Tor (more privacy).
- Disaster recovery: Data redundancy provided by the market.

So you create a toy application, fix bugs when they happen, done. You make sure your content has high quality. Others like scalability, high availability, disaster recovery stuff that requires a infrastructure team will be done by the market.

Downsides are obvious too.
- You lose monopoly control of the data and user experience.

How will you profit then? Many possibilities. Maybe as a KOL. You provide high quality content. So you can profit by advertising sponsored content.

## Migrating the client

<!-- Self-host service mode for blackbox client and in-app interceptor mode for outproxy and cashier -->

## Migrating mutation APIs

Good news, you do not need to migrate at all. All you need is to add a continuous backup mysql-proposer workload to dump the database and push to an object storage. But it also means we cannot make mutation API autonomous, in the sense that it earns itself money to cover its cost, and resists abusive spam DoS attacks in the wild. Because it highly depends on your business logic. On how you maintain your data quality. We cannot define a paradigm that works for all businesses in the world.

You continue to run your service, moderate contents based on traditional usernames. Using pesudonymous identities is optional and irrelevant to the PAID migration. The only new thing you do is to upload your database backups.

### Object storage

<!-- Migrate to OCI storage, not raw s3 because users need verifiability to use untrusted storage providers -->

<!-- Read more in ./oci-proposer.md -->

### Database backup

<!-- Guide to run mysql-proposer -->

<!-- Select database and table to export -->

<!-- Read more in ./database-proposer.md -->

### Serving backups

Where to put your backup files?
- In your own object storage and register to an index
- Outsource to someone else and register to an index
- Push to infrastructure providers directly

## Migrating read APIs

You need to make sure application usage for infrastructure providers is autonomous and fair. So people can serve your application and stay PAID.

We provide 2 common types of resource meters:
- Database access
  - sql middleware <!-- (TODO, the same as the HTTP SQL translator) -->
- Storage
  - kvstore with meter feedback

<!--
TODO: guide to meter other resource
- Create custom meter type
- Meter relatively
- Tune unit price dynamically
-->

<!-- Read ../infrastructure/meter.md for more -->

## Register at index

<!-- Registering the functionality -->

<!-- Registering your backup storage -->

<!-- Registering your mutation API -->
