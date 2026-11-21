# Meter

## Using meter

<!-- account, authz, deduction introduction and basic usage and configuration -->

<!-- Account: Points deposit, the jwt has timeout, double spending prevention with redeemer, redis or database backend choice, every account has timeout -->

<!-- Authz: DPoP based auth. Principal definition. Skip auth endpoints and allow zero balance endpoitns. auth format see docs/user-guide/client-auth.md -->

<!-- Deduction: Deduction by gateway. Deduction by metering app, for more control. They sum up. -->

<!-- Deduction model: per request, per resource type, record unit. Then fetch dynamic price, multiply aggregate. -->

### Gateway price keys

By default, gateway deduction looks up Redis prices at
`p:<TLS SNI>:<listener port>:<request path>`. A provider can group routes under a
shared price schedule by configuring the Envoy access-log custom tag
`meter_service`. A nonempty tag selects `p:<meter_service>` instead.

This tag is a PAID convention using Envoy's custom-tag mechanism. The kvstore
chart reads it from route metadata at `paid.meter.service`, setting `s3` on its
direct S3 routes. All object keys and list queries therefore share `p:s3`.
Request headers cannot override this metadata. Routes without the tag retain
their existing price keys.

Each gateway price hash contains `METER_TYPE_DURATION_MS`,
`METER_TYPE_INGRESS_BYTES`, and `METER_TYPE_EGRESS_BYTES`. Duration is measured in
milliseconds; ingress and egress include headers and bodies. Configure initial
prices through `meter.priceSeed.entries`, then adjust the Redis fields as needed.

## Cascade metering

<!-- Feedback metering: query resource usage a period later. Pull based usage reporting. External request id to track user. -->

## Unit price job

<!-- Cronjob to tune price based on envirnoment, like resource cost change, chain token price change, usage spikes. -->

<!-- Unit price format. FIXME: current has bug, should be based on connect path, not HTU -->

## In-cluster faucet for debugging

<!-- CreditBalance purpose -->

<!-- Usage example: outproxy setup, CreditBalance, GetBalance -->
