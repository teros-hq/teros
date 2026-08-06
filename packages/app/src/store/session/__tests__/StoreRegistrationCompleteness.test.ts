/**
 * CI Guard — Store Registration Completeness
 *
 * This test FAILS in CI if someone adds a new session store
 * and forgets to register it in the StoreRegistry.
 *
 * Instead of importing the stores (which pulls in React Native
 * dependencies that break in Bun test), we read the source files
 * directly and verify each store file contains a registration call.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const STORE_DIR = join(__dirname, '../../');

// Stores that are expected to have session lifecycle registration.
// Each must contain either `createSessionStore(` or `storeRegistry.register(`.
const EXPECTED_STORES = [
  'authStore.ts',
  'workspaceStore.ts',
  'chatStore.ts',
  'tilingStore.ts',
  'navbarStore.ts',
  'connectionStore.ts',
  'featureFlagsStore.ts',
  'uiPreferencesStore.ts',
  'boardStore.ts',
  'audioStore.ts',
];

describe('Store registration completeness', () => {
  it('every session store file contains a StoreRegistry registration', () => {
    const files = readdirSync(STORE_DIR);

    for (const storeFile of EXPECTED_STORES) {
      expect(files).toContain(storeFile);

      const content = readFileSync(join(STORE_DIR, storeFile), 'utf-8');
      const hasAutoRegister = content.includes('createSessionStore');
      const hasManualRegister = content.includes('storeRegistry.register(');
      const hasAliasedManualRegister = content.includes('sessionStoreRegistry.register(');

      expect(
        hasAutoRegister || hasManualRegister || hasAliasedManualRegister,
      ).toBe(true);
    }
  });

  it('no unexpected store files exist without registration', () => {
    const files = readdirSync(STORE_DIR)
      .filter((f) => f.endsWith('Store.ts') && f !== 'index.ts');

    for (const file of files) {
      if (EXPECTED_STORES.includes(file)) continue;

      const content = readFileSync(join(STORE_DIR, file), 'utf-8');
      const hasAutoRegister = content.includes('createSessionStore');
      const hasManualRegister = content.includes('storeRegistry.register(');
      const hasAliasedManualRegister = content.includes('sessionStoreRegistry.register(');

      // If a new store file exists but isn't in EXPECTED_STORES,
      // it must still have registration — otherwise the list is stale.
      expect(
        hasAutoRegister || hasManualRegister || hasAliasedManualRegister,
      ).toBe(true);
    }
  });
});
