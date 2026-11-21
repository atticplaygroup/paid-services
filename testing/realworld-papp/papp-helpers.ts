import { createAuthenticatedFetch } from '../../applications/client-auth/src/lib.ts';
import { readResolvers } from '../../examples/realworld-papp/frontend/adapters/reads.ts';
export const pappMutationOrigin = process.env.PAPP_MUTATION_ORIGIN ?? 'http://realworld-baseapp.pusher-ns.svc.cluster.local:3000';
export const replicaOrigin = 'http://realworld-replica-envoy.puller-ns.svc.cluster.local:8080';
export async function graphql(token: string, query: string, variables: any = {}) {
  const response = await fetch(pappMutationOrigin + '/api', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (!response.ok || result.errors) throw new Error(JSON.stringify(result));
  return result.data;
}
export function replicaReads(key: CryptoKeyPair, viewer = '') {
  const paid = createAuthenticatedFetch(key);
  return readResolvers(async query => {
    const response = await paid(replicaOrigin + '/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: query.sql, parameters: query.parameters }) });
    if (!response.ok) throw new Error(await response.text());
    const { columns, rows } = await response.json();
    return rows.map((row: any[]) => Object.fromEntries(columns.map((name: string, i: number) => [name, row[i]])));
  }, viewer);
}
export { until } from '../shared/wait.ts';
