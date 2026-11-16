# Routing E2E

This suite creates a standalone kind fixture using the production OCI, Kvstore,
index, and meter charts. MySQL and Redis are party-owned workloads.
`functionalities/oci/{ts,behavior,variant}` belongs to this fixture.

Run `build.sh`, `deploy.sh`, then `test.sh` with `CLUSTER_NAME` and `KUBECONFIG`
set for an existing kind cluster. `.github/workflows/e2e-routing.yaml` creates
its own cluster and runs those steps on pushes, pull requests, and manual runs.
Use `diagnostics.sh` to inspect a failed run.

The seed Job runs in the OCI party. It publishes signed definitions with
different behavior and variant maintainers, creates three random text files,
and registers the real provider between two dead providers by ingress time.
Index registration and searches use the generated protobuf/Connect client.
The dead providers have Envoy gateways with unreachable upstreams, so even
failed attempts enter a gateway. The client checks signature and owner linkage, exact search and pagination,
registration limits, authorization, expiration, curl retrieval, ordered
failover, and metering deductions. The local fetch interceptor discovers
directly from the index and pays it as the client. All service calls between parties
use their Envoy gateways. Fixture identities and expected random bytes are
passed to the test Job through Kubernetes Secrets and a ConfigMap.
