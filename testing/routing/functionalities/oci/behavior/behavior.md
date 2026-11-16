# Signed OCI file collection, v1

A provider MUST serve the OCI distribution read API for the requested collection.
A variant MUST include `behavior.json` identifying this behavior and `variant.json`
identifying the collection repository and tag. The variant maintainer MUST equal
that repository's owner. The behavior maintainer MAY be a different principal.
Clients MUST verify signed manifest anchors against each requested maintainer and
verify content digests. The collection MUST contain every file named by its manifest.
