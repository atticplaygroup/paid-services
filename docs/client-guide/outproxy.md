# Outproxy

Outproxy is a forward proxy that attaches PAID authorization to outbound requests. Use it when the client cannot mint DPoP itself: `curl`, browsers, language SDKs, or any HTTP client that only understands `HTTP_PROXY`.

You may have used a public outproxy in the quickstart. But typically you should run your own outproxy because you should manage your own authentication. It was for demo purpose only.

There are 2 identities involved:
- customer identity: how you identify your users
- service identity: you, your service, when you talks to others

Customer identity is authenticated separately by the application's account Envoy/authz layer and MUST NOT pass through the proxy. `x-user-id` and `x-request-id` are internal to a party (and may cross its workloads). `x-external-request-id` is used to help logging across parties. It will pass across parties.

Outproxy owns **service identity**. It injects authorization header when any this party's code, service, function, access external PAID resources. And it does not modify any other header or body.


## Usage

2 header injection modes:

- Blackbox mode, if you do not control the code. Requires trusting a self-signed CA.
  - HTTP forward proxy for `http://` targets.
  - HTTPS MITM proxy for `https://` targets. Outproxy answers `CONNECT`. It uses a self-signed CA certificate to generate TLS certificates on-the-fly, terminates TLS, then re-issues the request with an `Authorization` header.
- Interceptor mode, recommended if you control the code. No TLS fighting.
  - Use as a client middleware when you already control the code. Create an interceptor to call cashier or `dpop.generateProof` inject the authorization header. If you do not like a middleware, you can call it like a library too but middleware may make your developer experience easier.

2 bearer generation modes:

- Fixed key mode: the required `DPOP_MASTER_SECRET` BIP-39 mnemonic derives a P-256 key.
- Cashier mode: `CASHIER_ADDRESS` points at cashier. Outproxy derives the cashier account principal from `DPOP_MASTER_SECRET` and `CASHIER_ACCOUNT_SALT` and sends it as the internal `x-user-id`. Cashier funds and signs per host. Configure that derived principal in cashier's account list.

> [!INFO]
> 
> The internal cashier principal uses the same CIDv1 public JWK thumbprint encoding as other PAID principals. Different mnemonics or salts select different cashier accounts. The provider sees the principal bound to the cashier-issued proof. This may be helpful for example when you have multiple devices and want to track usage.

Choose cashier mode to enjoy automatic money management and some basic account separation. Fixed-key mode is enough for basic usage if you control the funding process externally.

### Blackbox mode

When you use a program without changing the code, you can use outproxy in blackbox mode.

For every forwarded request outproxy:

1. Injects `Authorization: Bearer ...`.
2. Modifies no other header and no body.

It strips hop-by-hop headers and does not rewrite application paths.

```bash
cd applications/outproxy
bun install
export LISTEN_ADDR=:9090
export DPOP_MASTER_SECRET="legal winner thank year wave sausage worth useful legal winner thank yellow"
# Option 1: fixed key mode; leave CASHIER_ADDRESS unset.
# Option 2: cashier mode. See ./cashier.md for how to run a cashier. Here we assume a trusted cashier at an HTTP endpoint.
export CASHIER_ADDRESS=http://127.0.0.1:8080
export CASHIER_ACCOUNT_SALT=cashier
# MITM CA certificate. TLS certificates will generate on-the-fly by user CONNECT. 
export CA_CERT_PATH=/path/to/ca.crt
bun run start
```

Test with curl:

```bash
curl --proxy http://127.0.0.1:9090 \
  -H 'content-type: application/json' \
  -d '{}' \
  https://kvstore.paid-services.com/account.v1.AccountService/GetBalance
```

### Interceptor mode

If you own the client, and do not want to MITM yourself with a self-signed certificate. Mint a proof and send it:

```ts
import * as dpop from "dpop"

const htu = "https://kvstore.paid-services.com/kvstore.v1.MeteredStorageService/GetCASValue"
// Option 1: fixed key mode
// const proof = await dpop.generateProof(keypair, htu, "POST")
// Option 2: cashier mode
const cashierConfig = // load async storage
const cashier = new Cashier(configConfig)
const proof = cashier.getAccessToken(...)
const response = await fetch(htu, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${proof}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ key: "bafkreigiyywomv3ur7dopm46bwkcpeeyiwotvdekfuq2armskkknts73qi" }),
})
```

That is the same header outproxy would have added. You can create an custom fetch function for reuse. Then it will act as an interceptor.

## Configuration

| Variable | Meaning |
| --- | --- |
| `LISTEN_ADDR` | Bind address, default `:9090` |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | Enable HTTPS `CONNECT` interception |
| `CA_CERT_PATH` | Extra CA when the upstream provider uses a private CA |
| `DPOP_MASTER_SECRET` | Required in both modes; BIP-39 mnemonic used to derive the service identity |
| `CASHIER_ADDRESS` | If set, ask cashier for each Bearer token |
| `CASHIER_ACCOUNT_SALT` | Required in cashier mode; salt used to derive the internal cashier account principal |

Setting `CASHIER_ADDRESS` selects cashier mode. Without it, outproxy mints proofs directly. `DPOP_MASTER_SECRET` is always required and validated at startup.


> [!INFO] Derivation of cashier principal
> 
> Cashier mode derives `seed = SHA-256(UTF-8(CASHIER_ACCOUNT_SALT) || UTF-8(NFKD(DPOP_MASTER_SECRET)))`, constructs its P-256 public JWK, then encodes the SHA-256 canonical JWK thumbprint as CIDv1 with the `jwk_jcs-pub` codec (`0xeb51`) and base32. See [cashier configuration](./cashier.md#cashier-config) for the command to compute the matching account principal. These salt bytes are used literally; they are not base64- or hex-decoded.

Outproxy preserves a supplied `x-request-id` when calling cashier. If it is missing, outproxy generates a UUID for that internal call.

## Public development utility

If you only want to use outproxy for devnet without deploying your outproxy and cashier, you can use the same outproxy in quickstart for this purpose. It deploys an independent [outproxy-with-faucet chart](charts/outproxy-with-faucet/README.md). Users connect to that proxy without needing a wallet or their own cluster.
