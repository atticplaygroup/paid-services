# Client authentication and authorization

PAID identities are public keys. A client authenticates by proving possession of a key on every request. There is no signup, email, or OAuth authorization server.

The proof is a half of [DPoP](https://datatracker.ietf.org/doc/html/rfc9449): the request-bound JWT. The usual OAuth access token in the Bearer position is omitted because PAID services are public. Anyone who can pay may call.

## Identity boundaries

Identity has two separate trust domains:

- **Customer identity** is proven to the application's account Envoy/authz layer with a DPoP proof. It belongs to the application boundary.
- **Service identity** is owned by the application's outproxy when it calls an infrastructure provider. The outproxy selects the service account and mints the provider-bound DPoP proof.

Applications MUST NOT forward customer identity headers across an infrastructure-provider boundary. The outproxy injects only `Authorization: Bearer ...` and is otherwise transparent.

## Authentication

Send:

```http
Authorization: Bearer <dpop-jwt>
```

The JWT is self-issued:

- Header `typ` is `dpop+jwt`.
- Header `jwk` carries the public key.
- The key can be any public key algorithm. P-256, EdDSA, RSA, others, all allowed because identity is defined by JKT.
- Claims include `htm`, `htu`, `iat`, and a unique `jti`.

`htu` is scheme + host + path, with query and fragment removed. `htm` is the HTTP method. Providers recompute both from the incoming request and reject a mismatch. Standard RFC9449 behavior.

If you use the Connect RPC endpoints, do note that the http methods are `POST`. Bind the proof to `POST` unless you are calling a documented GET path.

Go:

```go
proof, jkt, err := dpop.Mint(privateKey, "POST", "https://kvstore.paid-services.com/kvstore.v1.MeteredStorageService/GetCASValue")
```

Or in typescript: `const proof = await dpop.generateProof(keypair, htu, htm)`.

### Expiration

DPoP expiration: Authz accepts proofs for a short window. The default maximum age is 60 seconds. A proof older than that is rejected. Each `jti` is remembered until it expires, so replaying the same Bearer token fails. Do not mint long-lived tokens. Authz MUST reject long lived tokens to prevent jti memorization taking too much memory. Cashier and outproxy mint a new proof per request.

Point expiration: The points you buy will have an expiration time too. If you do not use, they just expire. This is to prevent points taking resource forever. To keep the workload autonomous.

### Principal encoding

The account is the public key. And it is represented in the multiformat-JKT format. You hash the canonical public JWK with SHA-256 and encode the digest as a CIDv1:

- hash: SHA-256 (`0x12`)
- codec: `jwk_jcs-pub` (`0xeb51`)
- multibase: base32

> [!INFO]
>
> `bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s` is an example of the encoded principal string. It is compact and DNS-safe. The public JWK contains only the required members for its key type. It is a canonical representation following RFC 7638 and JCS (RFC 8785).
>
> Compute a principal from a public JWK:
>
> ```typescript
> import { createHash } from "node:crypto"
> import { CID } from "multiformats/cid"
> import { create } from "multiformats/hashes/digest"
> const jwk = {"crv":"secp256k1","kty":"EC","x":"...","y":"..."}
> const digest = create(0x12, new Uint8Array(createHash("sha256").update(JSON.stringify({
>   crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y,
> })).digest()))
> console.log(CID.create(1, 0xeb51, digest).toString())
> ```
>
> Cashier isolates hosts by deriving a different curve seed per hostname for basic unlinkability:
>
> ```text
> seed = SHA-256(accountSalt || masterSecret || hostname)
> ```

## Authorization

Above are authentication. To prove you own the public key. But to be authorized to read or write, you need to pay for resource usage. 

But where does the first money come from? There is a parameter of ALLOW_ZERO_BALANCE_HTUS to expose some API to deposit money to prevent the chicken-and-egg problem of no money. Those exposed APIs SHOULD be protected too, like with a traditional WAF or some proof of work protection. Providers typically allow zero-balance access to bootstrap RPCs such as:

- `/account.v1.AccountService/DepositOrCreateAccount`
- `/account.v1.AccountService/CreditBalance`

Those RPCs still require a valid DPoP proof (authentication). They only skip the balance gate (authorization) so a new key can create or credit an account.

`CreditBalance` is an in-provider faucet for demos. Public mainnet providers should keep it disabled. When it is enabled:

```bash
curl -sS https://kvstore.paid-services.com/account.v1.AccountService/CreditBalance \
  -H "Authorization: Bearer ${PROOF}" \
  -H 'content-type: application/json' \
  -d '{"amount":1000000000}'
```

A successful body includes `account.accountId` and `account.balance`.
