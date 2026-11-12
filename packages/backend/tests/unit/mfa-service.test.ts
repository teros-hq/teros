/**
 * Tests for MFA Service
 * Tests the MFA setup/enable/disable/verify flow with a mock database
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { MFAService } from '../../src/auth/mfa-service';
import { generateTOTP } from '../../src/auth/totp';
import { secrets } from '../../src/secrets/secrets-manager';

// The TOTP secret is encrypted with the user's key (SEC-4): inject a system key
const secretsInternals = secrets as unknown as { loaded: boolean; systemSecrets: Map<string, unknown> };
secretsInternals.loaded = true;
if (!secretsInternals.systemSecrets.has('encryption')) {
  secretsInternals.systemSecrets.set('encryption', { masterKey: randomBytes(32).toString('hex') });
}

// Minimal in-memory mock of MongoDB Collection
function createMockCollection() {
  const docs: Map<string, any> = new Map();

  const collection: any = {
    findOne: async (filter: any) => {
      for (const doc of docs.values()) {
        if (matchFilter(doc, filter)) return doc;
      }
      return null;
    },
    find: () => ({
      sort: () => ({
        toArray: async () => [...docs.values()],
      }),
    }),
    insertOne: async (doc: any) => {
      docs.set(doc._id?.toString() || doc.userId, doc);
      return { insertedId: doc._id };
    },
    updateOne: async (filter: any, update: any) => {
      let modified = 0;
      for (const [key, doc] of docs.entries()) {
        if (matchFilter(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(key, doc);
          modified++;
        }
      }
      return { modifiedCount: modified };
    },
    updateMany: async (filter: any, update: any) => {
      let modified = 0;
      for (const [key, doc] of docs.entries()) {
        if (matchFilter(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(key, doc);
          modified++;
        }
      }
      return { modifiedCount: modified };
    },
    countDocuments: async (filter: any) => {
      let count = 0;
      for (const doc of docs.values()) {
        if (matchFilter(doc, filter)) count++;
      }
      return count;
    },
    createIndex: async () => ({}),
    deleteMany: async (filter: any) => {
      let deleted = 0;
      for (const [key, doc] of docs.entries()) {
        if (matchFilter(doc, filter)) {
          docs.delete(key);
          deleted++;
        }
      }
      return { deletedCount: deleted };
    },
    // Test helpers
    _docs: docs,
    _reset: () => docs.clear(),
    _add: (doc: any) => docs.set(doc.userId, doc),
  };

  return collection;
}

// Simple filter matcher (handles { userId, deletedAt: { $exists: false } }, etc.)
function matchFilter(doc: any, filter: any): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'deletedAt') {
      if (value && typeof value === 'object' && '$exists' in value) {
        const exists = key in doc;
        if (value.$exists === false && exists) return false;
        if (value.$exists === true && !exists) return false;
      }
      continue;
    }
    if (key === '_id') continue; // Skip _id matching for simplicity
    // Dotted paths ('mfa.secret') resolve into nested documents
    const actual = key.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), doc);
    if (actual !== value) return false;
  }
  return true;
}

// Simple update applier (handles $set, $unset)
function applyUpdate(doc: any, update: any) {
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      setNested(doc, key, value);
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      deleteNested(doc, key);
    }
  }
}

function setNested(obj: any, path: string, value: any) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function deleteNested(obj: any, path: string) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) return;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];
}

describe('MFAService', () => {
  let mockDb: any;
  let mockUsers: any;
  let mfaService: MFAService;

  beforeEach(() => {
    mockUsers = createMockCollection();
    const keys = createMockCollection();
    mockDb = { collection: (name: string) => (name === 'users' ? mockUsers : keys) };
    mfaService = new MFAService(mockDb);
  });

  describe('setupMFA', () => {
    it('should generate a secret and backup codes', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const result = await mfaService.setupMFA('user:test123');

      expect(result.secret).toBeTruthy();
      expect(result.secret).toMatch(/^[A-Z2-7]+$/);
      expect(result.otpauthURI).toMatch(/^otpauth:\/\/totp\//);
      expect(result.backupCodes).toHaveLength(10);
    });

    it('should store MFA config with enabled=false', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      await mfaService.setupMFA('user:test123');

      const user = await mockUsers.findOne({ userId: 'user:test123' });
      expect(user.mfa).toBeDefined();
      expect(user.mfa.enabled).toBe(false);
      // Stored encrypted, never in plaintext (SEC-4)
      expect(user.mfa.secret).toBeUndefined();
      expect(user.mfa.secretEnc?.data).toBeTruthy();
      expect(user.mfa.backupCodeHashes).toHaveLength(10);
      expect(user.mfa.backupCodesRemaining).toBe(10);
    });

    it('should throw if user not found', async () => {
      await expect(mfaService.setupMFA('user:nonexistent')).rejects.toThrow('User not found');
    });
  });

  describe('enableMFA', () => {
    it('should enable MFA with a valid TOTP code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);

      const enabled = await mfaService.enableMFA('user:test123', code);
      expect(enabled).toBe(true);

      const user = await mockUsers.findOne({ userId: 'user:test123' });
      expect(user.mfa.enabled).toBe(true);
    });

    it('should fail with an invalid TOTP code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      await mfaService.setupMFA('user:test123');

      const enabled = await mfaService.enableMFA('user:test123', '000000');
      expect(enabled).toBe(false);
    });

    it('should throw if MFA setup not initiated', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      await expect(mfaService.enableMFA('user:test123', '123456')).rejects.toThrow(
        'MFA setup not initiated',
      );
    });
  });

  describe('verifyMFA', () => {
    it('should verify a valid TOTP code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      // Now verify with a fresh code
      const verifyCode = generateTOTP(setup.secret);
      const result = await mfaService.verifyMFA('user:test123', verifyCode);
      expect(result.success).toBe(true);
    });

    it('should verify with a backup code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      // Use a backup code
      const backupCode = setup.backupCodes[0];
      const result = await mfaService.verifyMFA('user:test123', backupCode);
      expect(result.success).toBe(true);
      expect(result.usedBackupCode).toBe(true);
      expect(result.backupCodesRemaining).toBe(9);
    });

    it('should fail with invalid code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      const result = await mfaService.verifyMFA('user:test123', '000000');
      expect(result.success).toBe(false);
    });

    it('should consume a backup code only once', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      const backupCode = setup.backupCodes[0];

      // First use should succeed
      const result1 = await mfaService.verifyMFA('user:test123', backupCode);
      expect(result1.success).toBe(true);

      // Second use of the same backup code should fail
      const result2 = await mfaService.verifyMFA('user:test123', backupCode);
      expect(result2.success).toBe(false);
    }, 30_000);
  });

  describe('disableMFA', () => {
    it('should disable MFA with a valid TOTP code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      const disableCode = generateTOTP(setup.secret);
      const result = await mfaService.disableMFA('user:test123', disableCode);
      expect(result).toBe(true);

      const user = await mockUsers.findOne({ userId: 'user:test123' });
      expect(user.mfa).toBeUndefined();
    });

    it('should fail with invalid code', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      const result = await mfaService.disableMFA('user:test123', '000000');
      expect(result).toBe(false);
    });
  });

  describe('getMFAStatus', () => {
    it('should return enabled=false when MFA not set up', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'user',
      });

      const status = await mfaService.getMFAStatus('user:test123');
      expect(status?.enabled).toBe(false);
    });

    it('should return enabled=true when MFA is enabled', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      const status = await mfaService.getMFAStatus('user:test123');
      expect(status?.enabled).toBe(true);
      expect(status?.backupCodesRemaining).toBe(10);
    });
  });

  describe('regenerateBackupCodes', () => {
    // TOTP + crypto operations are slow — needs more than bun's 5s default
    it('should generate new backup codes', async () => {
      mockUsers._add({
        userId: 'user:test123',
        profile: { displayName: 'Test', email: 'test@example.com' },
        status: 'active',
        role: 'admin',
      });

      const setup = await mfaService.setupMFA('user:test123');
      const code = generateTOTP(setup.secret);
      await mfaService.enableMFA('user:test123', code);

      // Use one backup code
      await mfaService.verifyMFA('user:test123', setup.backupCodes[0]);

      // Regenerate
      const newCodes = await mfaService.regenerateBackupCodes('user:test123');
      expect(newCodes).toHaveLength(10);

      // Old backup codes should no longer work
      const result = await mfaService.verifyMFA('user:test123', setup.backupCodes[1]);
      expect(result.success).toBe(false);
    }, 30_000);
  });

  describe('legacy plaintext secret (SEC-4)', () => {
    it('still verifies, and encrypts the secret in place', async () => {
      const setup = await (async () => {
        mockUsers._add({
          userId: 'user:legacy',
          profile: { displayName: 'L', email: 'l@example.com' },
          status: 'active',
          role: 'admin',
        });
        return mfaService.setupMFA('user:legacy');
      })();
      // Simulate a record written by the old code: plaintext secret, no secretEnc
      const doc = await mockUsers.findOne({ userId: 'user:legacy' });
      doc.mfa = { ...doc.mfa, enabled: true, secret: setup.secret };
      delete doc.mfa.secretEnc;

      const result = await mfaService.verifyMFA('user:legacy', generateTOTP(setup.secret));

      expect(result.success).toBe(true);
      const after = await mockUsers.findOne({ userId: 'user:legacy' });
      expect(after.mfa.secret).toBeUndefined();
      expect(after.mfa.secretEnc?.data).toBeTruthy();
    });
  });
});
