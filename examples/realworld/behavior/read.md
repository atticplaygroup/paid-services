# RealWorld read behavior v1

The browser implements the RealWorld read operations for articles (including
feed, filters, pagination, counts and favorites), tags, profiles and comments.
The infrastructure API is POST /sql with JSON {sql, parameters}; responses are
{columns, rows}, with non-null values encoded as strings and SQL NULL as null.
The schema.sql publication is part of this version's API. Breaking schema or
result interpretation changes require a new behavior version.

Replica access MUST be read-only, authenticated with PAID and metered. Bind all
query parameters. Dates are UTC and exposed by the browser API as ISO 8601;
counts and comment IDs are JSON numbers, flags are JSON booleans. Profile bio
and image may be null. There is no OIDC credential forwarding to read providers.
