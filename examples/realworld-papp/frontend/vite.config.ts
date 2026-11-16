import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dependencies } from './package.json';
const adapter = (name: string) => fileURLToPath(new URL(`./adapters/${name}.tsx`, import.meta.url));
const local = (name: string) => fileURLToPath(new URL(name, import.meta.url));
// Reuse the base app without making it aware of the pApp. Its relative imports
// keep using shared hooks/contexts, with only these integrations replaced.
const overrides = new Map([
  ['lib/client/apollo-client', 'lib/client/apollo-client.ts'],
  ['lib/constants', 'lib/constants.ts'],
  ['adapters/oidc', 'adapters/oidc.ts'],
  ['generated/graphql', 'generated/graphql.ts'],
].flatMap(([upstream, replacement]) => [upstream, `${upstream}.ts`].map(path =>
  [local(`../baseapp/${path}`), local(`./${replacement}`)] as const)));
export default defineConfig({
  plugins: [{
    name: 'baseapp-integrations',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return;
      return overrides.get(resolve(dirname(importer.split('?')[0]), source));
    },
  }, react()],
  resolve: {
    // Imported sources must use the pApp's packages, including one React/Apollo
    // instance even when the traditional app has its own node_modules installed.
    dedupe: Object.keys(dependencies),
    alias: { 'next/router': adapter('router'), 'next/link': adapter('link'), 'next/image': adapter('image'), 'next/head': adapter('head'), 'next-seo': adapter('seo') },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { target: 'es2022' },
});
