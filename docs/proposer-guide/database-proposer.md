# Proposer database

A MySQL proposer publishes selected databases to an OCI registry. Replicas
restore a baseline (a consistent snapshot) and replay binlogs to reach the
latest published state. For example, the proposer can publish a baseline weekly
and a delta every five minutes; replicas check for updates every five minutes.
Replica MySQL is read-only for ordinary users. The privileged importer can
replace schemas and replay transactions.

## Manifest

Each publication includes `application-manifest.yaml`, which connects the
baseline and delta artifacts to an application and owner. For example:

```yaml
version: v1
owner: "database-provider"
application: "medium"
tag: "20261017143357510910888" # oci's tag of this manifest, use it to oras pull
databases:
  - type: mysql:v26.5.3
    name: "medium"
    tag: "20261017143357510910888" # database tag
    baseline:
      repo: "baseline_app"
      tag: "20261017143348857976585" # oci's tag of baseline repo, use it to oras pull
      gtid_end: "b9c8a5e5-ca37-11f1-9c01-e267583781df:1-6"
    delta:
      repo: "binlog_app"
      tag: "20261017143357510910888" # oci's tag of delta repo, use it to oras pull
      gtid_start: "b9c8a5e5-ca37-11f1-9c01-e267583781df:1-6"
      gtid_end: "b9c8a5e5-ca37-11f1-9c01-e267583781df:1-7"
    exported_schemas:
      - user_profile
      - public_catalog
storage: []
```

GTIDs identify executed transactions. `baseline.gtid_end` is the snapshot's
GTID set. `delta.gtid_start` records the GTID set at the beginning of the delta’s coverage;
`delta.gtid_end` records the GTID set at its end. The delta may overlap the
baseline; MySQL skips transactions already included in the replica’s
executed GTID set.

Baseline update and delta updates can be run independently.
A delta publication reuses the baseline artifact and creates new database and
manifest tags. Both artifact repos use the database tag. Integrity is checked by `importer.applicationOwner`'s signature by OCI.
To find the latest version, use the newest timestamp tag.

## Database schema configuration

Set `mysql.exportedSchemas` to the databases you want to publish. The proposer
uses this same list for baseline snapshots and MySQL's server-side
`binlog-do-db` filters. Binlogs use `ROW` format,
so row changes to tables outside the selection are not included in deltas.

Changing schemas requires restarting from a fresh baseline.

### Keeping private data out of publications

Limit SQLs of private schemas to some patterns to protect them. For example, avoid cross-database DDL and dependencies on excluded tables.

<!-- TODO: include more tips on protecting excluded schemas. -->

## Sync process

A repo is consist of 3 parts
- Baseline
- Delta
- Manifest

Restoring a baseline will restore a snapshot. Replay deltas to keep up with the latest changes.
Baselines and deltas are defined in the application manifest.

### Publishing a baseline

Published in MySQL Shell's format. GTID is enabled to help deduplicate statements. Baseline is published without tar archiving or compression. And it uses the mysqlsh storage format directly.

### Publishing deltas

MySQL is configured to export delta as binlog files. It exports delta, then a script
will parse its artifact binlog file, derive `gtid_start` and `gtid_end`, and using them
to update the manifest. No lock is involved.

Proposer publish baseline to the baseline repo, delta to the delta repo, independently, and only tag when generating a manifest.
Replica is who to ensure they are compatible, it needs some check otherwise it will fail. Compatible means the GTID range of baseline and deltas overlap.

Any baseline with the last GTID within the range of GTIDs of the delta files can be used
to reconstruct the database. The retention of delta files can be independent of baseline
update frequency. MySQL's binlog retention settings determine
which closed files the publisher exports. These are proposer side. Proposer set retention so, just like it runs a db transparently.
But replica retention is dependent on how long it is stored on storage providers. You could pay to store as long as possible.
Replicas will just select a baseline compatible with the coverage of the retained delta files.

### Restoring and following updates

These are replica's business but you can learn about it for a better understanding:

- File Sync: OCI storage sync is done independently of mysql restoration. A script will sync the OCI storage to a filesystem, or an s3, as long as it is some storage that mysqlsh supports.
- Baseline: Restore a baseline if the database is empty, settings changed, or corrupted. Use mysqlsh to restore it. It is the plain format of mysqlsh, so just use it to restore.
- Delta: After getting the files, importer will apply everything in delta/ blindly. Statements with GTID already applied will be ignored by the MySQL server. The importer MAY ignore already applied binlogs to save time.

## Packing to OCI

- Registry: You can use your own storage and let other people to download. So yourself becomes a storage provider. Or you can upload to other storage providers. You can even upload them separately to multiple providers. Users will verify signature by you. For how `applications/oci` verifes the integrity, check `../infra-guide/applications.md#oci`.
- Discovery: Use `repo` field in the manifest to discover the baseline and delta repo in the OCI. They may not coexist among different storage providers too. But they are signed by the proposer. So you can always download them from multiple storage providers, and use interchangablely. Discovering where you stored them is by routing. You register locations of them to an index. You register your application manifest to an index too.
- Tagging: Each upload gets a UTC timestamp tag: `YYYYMMDDHHMMSS` followed by nine digits for the fraction of a second. Manifest's root `tag` field matches the OCI tag of this manifest. Tags defined under its `databases` and `storage` will be compatible to describe a state of the application. However it is still eventual consistency. No locks are required to synchronize things. Baseline and manifest will have a `latest` tag, OCI tag.

An example registry storage layout:
```text
<registry>/
├── baseline_app:20261017143357510910888
│   └── baseline/       # MySQL Shell dump files
├── baseline_app:latest
│   └── baseline/       # MySQL Shell dump files
├── binlog_app:20261017143357510910888
│   └── delta/
│       ├── mysql-proposer-0-bin.000004
│       └── mysql-proposer-0-bin.000005
├── app-manifests:20261017143357510910888
│   └── application-manifest.yaml
└── app-manifests:latest
    └── application-manifest.yaml
```

### MySQL Shell baseline format example

We use standard MySQL Shell format for baseline. Below is an example:

```text
baseline/
├── @.json
├── @.done.json
├── @.sql
├── @.post.sql
├── public_catalog.json
├── public_catalog.sql
├── public_catalog@items.json
├── public_catalog@items.sql
├── public_catalog@items@@0.tsv.zst
├── public_catalog@items@@0.tsv.zst.idx
├── user_profile.json
├── user_profile.sql
├── user_profile@users.json
├── user_profile@users.sql
├── user_profile@users@@0.tsv.zst
└── user_profile@users@@0.tsv.zst.idx
```

| Files | Contents |
| --- | --- |
| `@.json` | Dump settings, schema list, GTID set, and binlog filename and position |
| `@.done.json` | Information saved when the dump finishes |
| `@.sql`, `@.post.sql` | Common SQL executed before and after loading |
| `user_profile.json`, `user_profile.sql` | Schema settings and SQL to create the schema |
| `user_profile@users.json`, `user_profile@users.sql` | Table settings and SQL to create the table |
| `*.tsv.zst` | Compressed table row data |
| `*.tsv.zst.idx` | Index files that help MySQL Shell load the row data |

Keep all the dump files together. MySQL Shell needs the SQL, row data, and
metadata files to load the baseline and record which transactions it contains.
It supports s3 too. But don't use kvstore's s3, which is wrapped and not exposed externally.
