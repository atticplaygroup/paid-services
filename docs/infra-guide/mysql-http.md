# Read-only SQL gateway

The index and MySQL replica charts can expose `POST /sql` through their Envoy
service. Requests use the same PAID Bearer authentication as the party's other
APIs. Send JSON such as `{"sql":"SELECT id FROM routing.advertisements LIMIT 10"}`.
Use optional `parameters` for MySQL `?` placeholders, for example
`{"sql":"SELECT id FROM routing.advertisements WHERE ingress_time > ? LIMIT ?","parameters":[0,10]}`.
Values are bound by MySQL, never inserted into the SQL text. Parameters may be
strings, numbers, booleans, or null. Send exact decimals and integers outside the
64-bit range as strings; fractional JSON numbers use floating-point binding.

The response contains `columns` and `rows`; every non-NULL cell is a string and SQL
NULL is JSON null. Clients interpret types. For binary data, select an encoding
such as `HEX(column)` that can be represented in JSON text.

Enable and configure the gateway in either chart:

```yaml
mysqlHttp:
  enabled: true
  adminDsn: root:password@tcp(mysql:3306)/routing
  access:
    schemas: []
    tables:
      routing: [advertisements]
  queryTimeout: 30s
  maxResultBytes: 8388608
meter:
  enabled: true
```

`access.schemas` grants SELECT on all tables in each listed schema, including
future tables. `access.tables` grants SELECT only on the named tables; those
tables must exist when provisioning runs. At least one grant is required.
The index provider search API and scoring remain available alongside `/sql`.

The init container uses the administrator DSN to create a dedicated reader,
reset its privileges, and grant the configured access. The administrator needs
account-management and SELECT grant privileges plus permission to disable session
binary logging. Provisioning disables binary logging so it does not add local
GTIDs to a replica. The reader name is derived from the release and namespace;
its password is generated in a release Secret and preserved across upgrades.
Only the init container receives administrator credentials. The running gateway
reads a reader-only DSN from a memory volume.

Each request executes one statement on a fresh physical MySQL connection, then
closes it. SQL syntax is passed to MySQL; its privileges enforce read-only access.
Timeout and client cancellation also terminate the server connection to release
query work, transactions, and advisory locks. Results are buffered subject to an
approximate size bound. Errors return HTTP 400, timeouts 504, and oversized results
413. The gateway accepts request bodies up to 1 MiB.

Configure the meter price hash `p:mysql` with duration, ingress, and egress prices
as described in [meter.md](meter.md). The Envoy route assigns the `mysql` service
tag, so prices apply to SQL independently of the provider search API. These are
relative consumption measures, not exact database CPU or I/O measurements.

Kysely can compile queries entirely on the client using its MySQL query compiler
and `DummyDriver`. Send the compiled query through the authenticated fetch:

```ts
const compiled = db.selectFrom("routing.advertisements")
  .select(["id", "ingress_time"])
  .where("ingress_time", ">", 0)
  .limit(10)
  .compile()

const response = await paidFetch(`${origin}/sql`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    sql: compiled.sql,
    parameters: compiled.parameters.map(value =>
      typeof value === "bigint" ? value.toString() : value),
  }),
})
```

The server does not need Kysely. JSON objects, arrays, dates, and binary data need
an application-defined scalar encoding before binding. The endpoint returns
column names and row arrays; a Kysely execution adapter would also need to map
these into row objects. Transactions cannot span HTTP requests.
