# Index

An index accepts signed provider advertisements and returns providers matching
an exact behavior and variant. See the [routing guide](../client-guide/routing.md)
for the registration, search, and signature formats. The protobuf contract is
`proto/index/v1/index.proto`; `index.v1.IndexService` supports Connect clients
using binary protobuf or protobuf JSON.

Deploy `charts/index` with `env.mysqlDsn` pointing to an existing MySQL database.
Set `env.enabledScorers` to the enabled `{implementation, functionality}` entries.
The current implementation is `ingress-time`. Searches request one or more
scoring functionalities and receive the supported matches.
The database user needs permission to create and update the advertisements table.
The chart runs the index behind Envoy and uses the shared `meter` chart for
DPoP authorization and duration, ingress, and egress billing. Configure the
meter's external Redis address, account audience, and unit prices as for other
PAID providers. Keep the database address within the index party.

The index records advertisement acceptance time and ranks newer advertisements
first. Provider expiration is enforced during search; physical cleanup is left
to a later release. Re-register an advertisement before its providers expire.

Clients can also search advertisements with SQL compiled on the client, including
Kysely queries. Enable `mysqlHttp` with a table whitelist for
`routing.advertisements` (or the index's configured schema). The
[SQL gateway guide](mysql-http.md) describes credentials, bound parameters, and
`p:mysql` metering. The provider search API and its scoring remain available.
