import type { Functionality } from '../../applications/papp-sdk/src/lib.ts';
export interface Config {
  indices: string[];
  providerScorings: Functionality[];
  proposerPrincipal: string;
  issuer: string;
  sql: Functionality;
}
