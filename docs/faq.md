# FAQ

## Concept

### Why do you want people to pay? Won't it limit the scale to only users who are willing to pay?

Not necessarily. A possible use case is that, users who are not willing to pay can visit a web page with advertisements. The web page is still a PAID application provider because it pays other PAID providers for resources it uses, and profit from the advertisements.

PAID service is a model to decompose the responsiblity of an app to multiple parties and let them coorperate. It can degenerate to a traditional app by being 1 party only. It just models the world better where providers do not trust each other and want to scale apps.

### Why is a proposer identified by its public key? Aren't modern OIDC, DID or DNS systems more flexible?

Yes, OIDC or some DID system have many advantages, like better support for key management, and human memorable nickname identities. But we want to be compatible with a stronger threat mode where PKIs or certificate providers are not trusted.

And the benefit of memorable identities may diminish as strong routing recommenders develop, where human no longer need to remember a brand (e.g. Google) to get service. They only say they want some functionality (e.g. search engine) and routing will automatically find the most suitable search engine available. So by that time if human no longer need to remember identites, using public keys as trust anchor is more acceptable.

## Client

### Do you support TCP access? Like can I run raw mysql or postgres connection to a PAID service?

No plan yet. May use mTLS with a SPIFFE system but it gets complicated. A workaround is to replicate the resource from their S3 to your own and access it with your TCP client.


