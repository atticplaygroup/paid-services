import { ApolloClient, ApolloLink, Observable, createHttpLink } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { buildSchema, execute, getOperationAST } from 'graphql';
import schemaText from '../../generated/schema.graphql?raw';
import { readResolvers } from '../../adapters/reads';
import { sqlExecutor } from '../../adapters/sql';
import { cache } from '../../../baseapp/lib/cache';
const schema = buildSchema(schemaText);
const activeReads = new Set<AbortController>();
globalThis.addEventListener?.('pagehide', () => { for (const controller of activeReads) controller.abort(); activeReads.clear(); });
export const errorLink = onError(({ graphQLErrors, networkError }) => {
  if (process.env.NODE_ENV === 'development') console.error(graphQLErrors, networkError);
});
// Account APIs are pinned to the proposer, independent of PAID discovery.
export const httpLink = createHttpLink({ uri: globalThis.PAID_CONFIG.mutationOrigin + '/api', fetchOptions: { redirect: 'error' } });
const accountFields = new Set(['currentUser', 'checkUsername']);
export const cacheLink = new ApolloLink((operation, forward) => {
  const ast = getOperationAST(operation.query, operation.operationName);
  if (ast?.operation !== 'query' || ast.selectionSet.selections.some(s => s.kind === 'Field' && accountFields.has(s.name.value))) return forward(operation);
  return new Observable(observer => {
    const controller = new AbortController();
    activeReads.add(controller);
    const token = operation.getContext().headers?.authorization?.replace(/^Bearer /, '') ?? '';
    const viewer = token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub : '';
    const resolvers = readResolvers(sqlExecutor(globalThis.PAID_CONFIG, controller.signal), viewer);
    Promise.resolve(execute({ schema, document: operation.query, variableValues: operation.variables, operationName: operation.operationName, fieldResolver(source, args, context, info) {
      const resolver = (resolvers as any)[info.parentType.name]?.[info.fieldName];
      return resolver ? resolver(source, args, context, info) : source?.[info.fieldName];
    } })).then(result => { activeReads.delete(controller); observer.next(result as any); observer.complete(); }, error => { activeReads.delete(controller); observer.error(error); });
    return () => { activeReads.delete(controller); controller.abort(); };
  });
});
export default new ApolloClient({ link: ApolloLink.from([errorLink, cacheLink, httpLink]), cache });
