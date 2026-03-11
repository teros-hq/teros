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
});
