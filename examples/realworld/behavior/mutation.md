# RealWorld mutation behavior v1

Implement the RealWorld user, profile-follow, article, favorite and comment
mutation APIs. Authentication uses OIDC tokens. Credentials and email remain
with the IdP, outside the published schema. GET /api/user belongs to identity
management at the proposer. POST /api/session provisions an OIDC user's public
profile after authorization-code/PKCE login. The tutorial fixture also provides
an IdP adapter for RealWorld's password registration/login API tests.

Return RealWorld response envelopes and 422 validation errors, reject missing
or invalid tokens with 401, reject non-owner article/comment modifications
with 403, and return 404 for absent resources. Repeated follow/favorite writes
are idempotent. Mutation responses reflect committed primary data. Subsequent
replica reads are asynchronous. Clients MUST NOT automatically replay mutations
after ambiguous dispatch failures.

A client MUST verify a valid advertisement signature from its intended proposer
principal covering the selected destination before sending an OIDC credential.
