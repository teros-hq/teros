// =============================================================================
// Barrel export for the 1Password client
// =============================================================================

export {
  getClient,
  clearClientCache,
  setClientFactory,
  clientFactory,
} from './onepassword-client.js';
export type { OnePasswordApi, OnePasswordSecrets, SdkClient } from './onepassword-client.js';
