/**
 * Unit tests for SecretsManager
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { secrets } from './secrets-manager';

describe('SecretsManager', () => {
  beforeAll(async () => {
    await secrets.load();
  });

  describe('system secrets', () => {
    test('should load database secret', () => {
      const db = secrets.system('database');
      expect(db).toBeDefined();
      expect(db?.uri).toBeDefined();
      expect(db?.database).toBeDefined();
    });

    test('should load auth secret', () => {
      const auth = secrets.system('auth');
      expect(auth).toBeDefined();
      expect(auth?.sessionTokenSecret).toBeDefined();
    });

    test('should load encryption secret', () => {
      const encryption = secrets.system('encryption');
      expect(encryption).toBeDefined();
      expect(encryption?.masterKey).toBeDefined();
      expect(encryption?.masterKey.length).toBe(64); // 32 bytes hex = 64 chars
    });

    test('should return undefined for non-existent secret', () => {
      const missing = secrets.system('non-existent');
      expect(missing).toBeUndefined();
    });

    test('should check if secret exists', () => {
      expect(secrets.hasSystem('database')).toBe(true);
      expect(secrets.hasSystem('non-existent')).toBe(false);
    });

    test('should throw error for required missing secret', () => {
      expect(() => {
        secrets.requireSystem('non-existent');
      }).toThrow();
    });

    test('should validate secret structure', () => {
      const db = secrets.requireSystem('database');

      expect(() => {
        secrets.validateSecret(db, ['uri', 'database'], 'database');
      }).not.toThrow();

      expect(() => {
        secrets.validateSecret(db, ['uri', 'missing-key'], 'database');
      }).toThrow();
    });
  });

  describe('MCA secrets', () => {
    test('should load MCA secret if exists', () => {
      const perplexity = secrets.mca('mca.teros.perplexity');

      if (perplexity) {
        expect(perplexity.apiKey).toBeDefined();
      } else {
        // Optional secret, not an error
        expect(perplexity).toBeUndefined();
      }
    });

    test('should check if MCA secret exists', () => {
      const hasPerplexity = secrets.hasMCA('mca.teros.perplexity');
      expect(typeof hasPerplexity).toBe('boolean');
    });
  });

  describe('type safety', () => {
    test('should provide type-safe access to known secrets', () => {
      const db = secrets.system('database');

      if (db) {
        // TypeScript should know about these properties
        const uri: string = db.uri;
        const database: string = db.database;

        expect(uri).toBeDefined();
        expect(database).toBeDefined();
      }
    });
  });

  describe('hot-reload (getMcaFresh / getSystemFresh)', () => {
    const testBasePath = '/tmp/secrets-hotreload-test';
    let freshManager: InstanceType<typeof import('./secrets-manager').SecretsManager>;

    beforeAll(async () => {
      // Create a fresh SecretsManager pointing to a temp directory
      const { SecretsManager } = await import('./secrets-manager');
      freshManager = new SecretsManager(testBasePath);

      // Ensure clean slate
      const { rmSync, mkdirSync, writeFileSync } = await import('fs');
      rmSync(testBasePath, { recursive: true, force: true });
      mkdirSync(`${testBasePath}/system`, { recursive: true });
      mkdirSync(`${testBasePath}/mcas/mca.test.hotreload`, { recursive: true });

      // Write initial secrets
      writeFileSync(
        `${testBasePath}/system/initial.json`,
        JSON.stringify({ key: 'initial-value' }),
      );
      writeFileSync(
        `${testBasePath}/mcas/mca.test.hotreload/credentials.json`,
        JSON.stringify({ apiKey: 'initial-key' }),
      );

      await freshManager.load();
    });

    test('should return cached value for existing MCA secret', () => {
      const cached = freshManager.mca('mca.test.hotreload');
      expect(cached).toBeDefined();
      expect(cached?.apiKey).toBe('initial-key');
    });

    test('should return cached value for existing system secret', () => {
      const cached = freshManager.system('initial');
      expect(cached).toBeDefined();
      expect(cached?.key).toBe('initial-value');
    });

    test('getMcaFresh should return same value as cache for existing secret', () => {
      const fresh = freshManager.getMcaFresh('mca.test.hotreload');
      expect(fresh).toBeDefined();
      expect(fresh?.apiKey).toBe('initial-key');
    });

    test('getSystemFresh should return same value as cache for existing secret', () => {
      const fresh = freshManager.getSystemFresh('initial');
      expect(fresh).toBeDefined();
      expect(fresh?.key).toBe('initial-value');
    });

    test('getMcaFresh should return undefined for non-existent MCA', () => {
      const fresh = freshManager.getMcaFresh('mca.does.not.exist');
      expect(fresh).toBeUndefined();
    });

    test('getSystemFresh should return undefined for non-existent system secret', () => {
      const fresh = freshManager.getSystemFresh('does-not-exist');
      expect(fresh).toBeUndefined();
    });

    test('should see MCA credentials created AFTER load() without restart', async () => {
      const { writeFileSync, mkdirSync } = await import('fs');
      const newMcaId = 'mca.test.created-after-boot';
      mkdirSync(`${testBasePath}/mcas/${newMcaId}`, { recursive: true });
      writeFileSync(
        `${testBasePath}/mcas/${newMcaId}/credentials.json`,
        JSON.stringify({ apiKey: 'created-after-boot' }),
      );

      // Cache should NOT have it (loaded before file existed)
      const cached = freshManager.mca(newMcaId);
      expect(cached).toBeUndefined();

      // Fresh read SHOULD find it
      const fresh = freshManager.getMcaFresh(newMcaId);
      expect(fresh).toBeDefined();
      expect(fresh?.apiKey).toBe('created-after-boot');

      // Cache should now be updated too
      const cachedAfter = freshManager.mca(newMcaId);
      expect(cachedAfter).toBeDefined();
      expect(cachedAfter?.apiKey).toBe('created-after-boot');
    });

    test('should see system secret created AFTER load() without restart', async () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        `${testBasePath}/system/created-after-boot.json`,
        JSON.stringify({ key: 'created-after-boot' }),
      );

      const cached = freshManager.system('created-after-boot');
      expect(cached).toBeUndefined();

      const fresh = freshManager.getSystemFresh('created-after-boot');
      expect(fresh).toBeDefined();
      expect(fresh?.key).toBe('created-after-boot');
    });

    test('should see EDITED MCA credentials on next fresh read', async () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        `${testBasePath}/mcas/mca.test.hotreload/credentials.json`,
        JSON.stringify({ apiKey: 'edited-key', newField: 'new-value' }),
      );

      // Cache still has old value
      const cached = freshManager.mca('mca.test.hotreload');
      expect(cached?.apiKey).toBe('initial-key');

      // Fresh read picks up the edit
      const fresh = freshManager.getMcaFresh('mca.test.hotreload');
      expect(fresh?.apiKey).toBe('edited-key');
      expect(fresh?.newField).toBe('new-value');
    });

    test('should see EDITED system secret on next fresh read', async () => {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        `${testBasePath}/system/initial.json`,
        JSON.stringify({ key: 'edited-value' }),
      );

      const cached = freshManager.system('initial');
      expect(cached?.key).toBe('initial-value');

      const fresh = freshManager.getSystemFresh('initial');
      expect(fresh?.key).toBe('edited-value');
    });

    test('should remove stale cache entry when MCA credentials file is deleted', async () => {
      const { rmSync } = await import('fs');
      rmSync(`${testBasePath}/mcas/mca.test.hotreload/credentials.json`);

      const fresh = freshManager.getMcaFresh('mca.test.hotreload');
      expect(fresh).toBeUndefined();

      // Cache should also be cleared
      const cached = freshManager.mca('mca.test.hotreload');
      expect(cached).toBeUndefined();
    });

    test('should keep stale cache when fresh read hits a parse error', async () => {
      const { writeFileSync, mkdirSync } = await import('fs');
      mkdirSync(`${testBasePath}/mcas/mca.test.parse-error`, { recursive: true });
      writeFileSync(
        `${testBasePath}/mcas/mca.test.parse-error/credentials.json`,
        '{ invalid json',
      );

      // Pre-populate cache with a valid value
      (freshManager as any).mcaSecrets.set('mca.test.parse-error', { apiKey: 'cached-valid' });

      const fresh = freshManager.getMcaFresh('mca.test.parse-error');
      // Should fall back to stale cache, not crash
      expect(fresh).toBeDefined();
      expect(fresh?.apiKey).toBe('cached-valid');
    });
  });
});
