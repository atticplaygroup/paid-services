# PAID Services

PAID is short for **P**ermissionless, **A**utonomous, **I**ncentivized and **D**ecoupled, a pattern like SaaS to scale federated apps by payments on metered usage. Data is managed by the market. You lose control once uploaded. PAID is a pattern to run apps decentralized under this world model.

PAID services are:

- **P**ermissionless: Self-registered pseudo-identity participation
- **A**utonomous: Sustainably run with resistance to abuse from the public Internet with little human intervention
- **I**centivized: Scalablity in the real world by generating revenue for parties involved
- **D**ecoupled: Composable switches with compatible and competitive providers

Get PAID if:
- You want your data to be openly accessible, as a Proposer
- Serve open data for money, as an Infrastructure provider
- Attract users to your website with rich open contents and resources, and profit traditionally like with advertisements to bridge the unwillingness of users to pay, as an Application provider
- You want to view contents managed by your favorate moderator with your favorate custom client app with a competitive market of recommenders and contents, as a user

## Why getting PAID

Because the interest of users and platforms differ. Platforms are incentivized to exploit users with advertisements and conservative moderations. Users are locked in the platform. We bring competence back. Even if we don't beat them in the end, we give them the pressure to serve users better.

Let's be concrete. Take social network as an example. The philosophy is similar to Nostr:
| Traditionally                                | In PAID services          |
| ----------------------------------------------| ---------------------------|
| Users are locked-in                          | Data is open              |
| Moderate uniformly and conservatively        | Choose your own moderator |
| Terms change overnight and forced acceptance | Choose your own provider  |
| Forced user interface or update              | Choose your own UI        |

But PAID services bring incentive to achieve scalability, bring upsides back, and even compete with traditional platforms.
| Traditionally             | In PAID services                        |
| ---------------------------| -----------------------------------------|
| Telemetry and tracking    | Tradeoff utility and privacy yourself   |
| Advertisements            | Switch provider or pay usage            |
| Improve algorithms slowly | Recommenders compete openly             |
| API restrictions          | On-demand payment or just replicate all |

Further, by decoupling the functionality of a platform, interesting applications emerge:
| Traditionally                            | In PAID services                                          |
| ------------------------------------------| -----------------------------------------------------------|
| Data isolation by companies cannot share | Cross-app recommendation with local data                  |
| Large bills for sharp SLA paid to cloud  | Propose behind Tor, outsource serving to market           |
| Privacy locked in company by law         | Earn money from model trainers with your browsing history |
| Websites locked in by domain name        | Keep the identity key and switch domain name at will      |

## Quickstart

Fetch a text file from an outproxy who runs on devnet faucet.
<!-- TODO: change domain stubs and make the quickstart work -->

```bash
HTTP_PROXY=outproxy-insecure.paid-services.com curl http://paid-services.com/kvstore/meter.v1.MeteredStorageService/GetCASValue/bafka83hc4nk9xji86eqvt9aqa6coyvu35kllt4hvjpza8x9glm345mvch
```
```
Welcome, PAID user!
```

If you got HTTP hijacked, run your own outproxy with a self signed certificate inside to modify curl.
```bash
docker run -e=HTTP_PROXY=http://127.0.0.1:8080 --rm oci.paid-services.com/outproxy-demo-cert-pinned:latest bash -c 'curl https://paid-services.com/kvstore/meter.v1.MeteredStorageService/GetCASValue/bafka83hc4nk9xji86eqvt9aqa6coyvu35kllt4hvjpza8x9glm345mvch'
```
```
Welcome, PAID user!
```

Read ./docs/quickstart.md to know what happened behind the scene, including who paid the fetching for you, and how.

## Documentation

Documentation is available in ./docs.

## Contributing

Contributions are welcome. See ./docs/CONTRIBUTING.md for guidance.

## License

Apache 2.0
