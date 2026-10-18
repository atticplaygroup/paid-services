# Meter

## Using meter

<!-- account, authz, deduction introduction and basic usage and configuration -->

<!-- Account: Points deposit, the jwt has timeout, double spending prevention with redeemer, redis or database backend choice, every account has timeout -->

<!-- Authz: DPoP based auth. Principal definition. Skip auth endpoints and allow zero balance endpoitns. auth format see docs/user-guide/client-auth.md -->

<!-- Deduction: Deduction by gateway. Deduction by metering app, for more control. They sum up. -->

<!-- Deduction model: per request, per resource type, record unit. Then fetch dynamic price, multiply aggregate. -->

## Cascade metering

<!-- Feedback metering: query resource usage a period later. Pull based usage reporting. External request id to track user. -->

## Unit price job

<!-- Cronjob to tune price based on envirnoment, like resource cost change, chain token price change, usage spikes. -->

<!-- Unit price format. FIXME: current has bug, should be based on connect path, not HTU -->

## In-cluster faucet for debugging

<!-- CreditBalance purpose -->

<!-- Usage example: outproxy setup, CreditBalance, GetBalance -->
