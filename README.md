# PAID Services

PAID is short for **P**ermissionless, **A**utonomous, **I**ncentivized and **D**ecoupled, a pattern like SaaS to scale federated apps by payments on metered usage. Data is managed by the market. You lose control once uploaded. PAID is a pattern to run apps decentralized under this world model.

PAID services are:

- **P**ermissionless: Self-registered pseudo-identity participation
- **A**utonomous: Sustainably run with resistance to abuse from the public Internet with little human intervention
- **I**centivized: Scalability in the real world by generating revenue for parties involved
- **D**ecoupled: Composable switches with compatible and competitive providers

Get PAID if:
- You want your data to be openly accessible, as a Proposer
- Let your idle computation resource earn money like blockchain mining, as an Infrastructure provider
- Attract users to your website with rich open contents and resources, and profit traditionally like with advertisements to bridge the unwillingness of users to pay, as an Application provider
- You want to view contents managed by your favorite moderator with your favorite custom client app with a competitive market of recommenders and contents, as a user

[Motivation](./docs/concepts/motivation.md) page discusses more on pros and cons of PAID services.

## Quickstart

Fetch a text file from an outproxy who runs on devnet faucet.
<!-- TODO: change domain stubs and make the quickstart work -->

```bash
HTTPS_PROXY=https://outproxy.paid-services.com:8443 curl --fail-with-body -sS --noproxy '' \
  --cacert <(curl --fail-with-body -sS https://outproxy.paid-services.com/ca.crt)> \
  -H 'content-type: application/json' -H 'x-request-id: quickstart-read-https' \
  -d '{"key":"bafkreihfqce2w5fkfwct23alewvtt56pwg7yzeayg4tfhjme57ie44qbam"}' \
  https://kvstore.paid-services.com/kvstore.v1.MeteredStorageService/GetCASValue \
  | jq -er .value | base64 -d
```
```
Welcome, PAID user!
```

Read [quickstart](./docs/quickstart.md) to know what happened behind the scene, including who paid the fetching for you, and how.

See [demo deployment and testing](docs/developer-guide/quickstart-demo.md) for configuration and [OCI push and pull](testing/oci/README.md) for the OCI flow.

## Documentation

Documentation is under construction. Concepts, quickstart and client guides are now available in ./docs.

<!--
## Contributing

Contributions are welcome. See the [contributor guide](docs/contributing.md) for setup, testing, and pull request guidance.
-->

## License

Apache 2.0
