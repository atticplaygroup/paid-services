# Operate a pApp gateway

A [pApp (PAID App)](../proposer-guide/papp.md) is like a dApp that runs locally and connects to "miners" (service providers)
to get content to show to the user. It serves from websites too.

## Design

The pApp gateway works like the IPFS Gateway. PApps are separated by origin to provide browser isolation. But users may want shared router and cashier configurations. The pApp gateway provides the feature.

Each pApp is served at its own `{papp-id}.{domain}` origin. You configure the settings in `config.{domain}`, for example `config.apps.example.com`. The papp domain `{papp-id}.{domain}` will bounce to it to retrieve serialized config.

- A user server is where router and cashier lives. It resolves, funds and proxies a PAID request and return responses
- The config only contains how to connect to the user server but not secrets
  - Current implementation assumes no secrets to access user server, with localhost trusted access
    - It is vulnerable. For example an attack is that a malicious pApp may guess your serving address, and trigger requests to access it
    - A better solution is to use something like walletconnect

The pApp gateway only serves a bootstrap page with service worker. All other information will be fetched over the service worker. The gateway does not know any papp. The service worker will resolve them when you access them. This will make the gateway simple to serve and maintain, and even can be served via content addressable storage. If you worry a website runs untrusted code, you can download, server at localhost, and run yourself. There is no papp specific data to download or install.

PApps aim to provide similar frontend security with an HTTPS website. The integrity of the pApp being served will be checked. The check is against its proposer. Make sure you trust the proposer. Phishing is not prevented. The gateway is assumed to be trusted. If not, run your own at localhost.
- The gateway access has the same security as HTTPS because it is HTTPS
- The service worker cannot be tampered because browser will reject it if it is from another origin than the gateway
- The service worker will check the integrity of the pApp
  - The integrity of webpage files are verified to follow the UnixFS IPLD structure and mathing the CID defined in the functionality manifest
  - The manifest is signed by the proposer
  - The identity of proposer is encoded as the [JKT principal](../client-guide/client-auth.md#principal-encoding) and is provided as input to check

## Usage

For your own gateway, provision DNS and TLS for `apps.example.com` and
`*.apps.example.com`. The wildcard covers both app IDs and the configuration
host `config.apps.example.com`. Route them to the same gateway service. Your
reverse proxy must preserve the requested hostname.

Install dependencies with `bun install --frozen-lockfile` in
`applications/client-auth`, `applications/router`, `applications/ipfs`,
`applications/papp-sdk`, and `applications/papp-gateway`. From the repository root:

```sh
export PAPP_GATEWAY=apps.example.com
export PORT=3003
bun applications/papp-gateway/src/server.ts
```

`PAPP_GATEWAY` is a hostname without a scheme or port. Terminate HTTPS at your
reverse proxy, or set `TLS_CERT` and `TLS_KEY` to certificate and key paths for
the server.

`PAPP_OBJECTS` and `PAPP_DELEGATED_ROUTING_URL` are not reviewed. These 2 options may be agent churns.

`/healthz` is available for health check.
