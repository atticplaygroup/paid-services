# RealWorld object behavior v1

Use PAID KvStore CreateCASValue/GetCASValue with raw SHA-256 CIDv1 identifiers.
Reads and uploads require PAID authentication and metering. Clients verify the
retrieved bytes against the CID before displaying them. The browser fetches
media using authenticated fetch and displays Blob URLs; plain image requests
are not a substitute for authenticated retrieval.
