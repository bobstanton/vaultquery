import { VAULTQUERY_FUNCTION_SIGNATURES } from './SqlCatalog';

export const TRIGGER_FUNCTION_NAMES = [...new Set(VAULTQUERY_FUNCTION_SIGNATURES
  .filter(signature => signature.scope === 'trigger').map(signature => signature.name))];
