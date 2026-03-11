/**
 * Auth Manager
 *
 * Manages user credentials with per-user encryption
 */

import { type Db, ObjectId } from 'mongodb';
import { secrets } from '../secrets/secrets-manager';
import { decrypt, encrypt, generateKey, generateSalt } from './encryption';
import type { EncryptedData, UserCredentialDocument, UserEncryptionKeyDocument } from './types';
import { UserAuthContext } from './user-auth-context';

export class AuthManager {
  private mcaIdCache: Map<string, string> = new Map();

  constructor(private db: Db) {}

  /**
   * Create auth context for a user
   */
  forUser(userId: string): UserAuthContext {
    return new UserAuthContext(userId, this);
  }

  /**
   * Get credentials for a user's app
   * Returns decrypted data or undefined
   */
  async get(userId: string, appId: string): Promise<any> {
    const doc = await this.getCredentialDoc(userId, appId);

    if (!doc || doc.revokedAt) {
      return undefined;
    }

    // Update lastUsedAt
    await this.db
      .collection<UserCredentialDocument>('user_credentials')
      .updateOne({ userId, appId }, { $set: { lastUsedAt: new Date() } });

    // Decrypt and return
    return this.decryptCredentials(userId, {
      data: doc.encryptedData,
      iv: doc.encryptionIv,
      tag: doc.encryptionTag,
    });
  }

  /**
   * Set credentials for a user's app
   */
  async set(userId: string, appId: string, mcaId: string, data: any): Promise<void> {
    // Encrypt credentials
    const encrypted = await this.encryptCredentials(userId, data);

    // Upsert document
    await this.db.collection<UserCredentialDocument>('user_credentials').updateOne(
      { userId, appId },
      {
        $set: {
          mcaId,
          encryptedData: encrypted.data,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
          updatedAt: new Date(),
        },
        $unset: {
          revokedAt: '',
        },
        $setOnInsert: {
          createdAt: new Date(),
          lastUsedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  /**
   * Revoke credentials (mark as revoked)
   */
  async revoke(userId: string, appId: string): Promise<void> {
    await this.db
      .collection<UserCredentialDocument>('user_credentials')
      .updateOne({ userId, appId }, { $set: { revokedAt: new Date() } });
  }

  /**
   * Get credential document (internal use)
   */
  async getCredentialDoc(userId: string, appId: string): Promise<UserCredentialDocument | null> {
    return this.db.collection<UserCredentialDocument>('user_credentials').findOne({
      userId,
      appId,
    });
  }

  /**
   * Get mcaId from apps collection
   * Uses cache to avoid repeated queries
   */
  async getMcaIdFromApp(appId: string): Promise<string> {
    // Check cache first
    if (this.mcaIdCache.has(appId)) {
      return this.mcaIdCache.get(appId)!;
    }

    // Query apps collection
    const app = await this.db
      .collection('apps')
      .findOne({ _id: new ObjectId(appId) }, { projection: { mcaId: 1 } });

    if (!app?.mcaId) {
      throw new Error(`App ${appId} not found or missing mcaId`);
    }

    // Cache it
    this.mcaIdCache.set(appId, app.mcaId);

    return app.mcaId;
  }

  /**
   * List all app IDs with credentials for a user
   */
  async listUserApps(userId: string): Promise<string[]> {
    const docs = await this.db
      .collection<UserCredentialDocument>('user_credentials')
      .find({
        userId,
        revokedAt: { $exists: false },
      })
      .project({ appId: 1 })
      .toArray();

    return docs.map((doc) => doc.appId);
  }

  /**
   * List app IDs for a specific MCA
   */
  async listByMCA(userId: string, mcaId: string): Promise<string[]> {
    const docs = await this.db
      .collection<UserCredentialDocument>('user_credentials')
      .find({
        userId,
        mcaId,
        revokedAt: { $exists: false },
      })
      .project({ appId: 1 })
      .toArray();

    return docs.map((doc) => doc.appId);
  }

  /**
   * Encrypt credentials using user's encryption key
   */
  private async encryptCredentials(userId: string, data: any): Promise<EncryptedData> {
    const userKey = await this.getUserEncryptionKey(userId);
    return encrypt(data, userKey);
  }

  /**
   * Decrypt credentials using user's encryption key
   */
  private async decryptCredentials(userId: string, encrypted: EncryptedData): Promise<any> {
    const userKey = await this.getUserEncryptionKey(userId);
    return decrypt(encrypted, userKey);
  }

  /**
   * Get or create user's encryption key
   */
  private async getUserEncryptionKey(userId: string): Promise<Buffer> {
    // Try to get existing key
    const keyDoc = await this.db
      .collection<UserEncryptionKeyDocument>('user_encryption_keys')
      .findOne({ userId });

    if (keyDoc) {
      // Decrypt master key with system key
      return this.decryptMasterKey(keyDoc.encryptedMasterKey);
    }

    // Create new key for user
    return this.createUserEncryptionKey(userId);
  }

  /**
   * Create new encryption key for user
   */
  private async createUserEncryptionKey(userId: string): Promise<Buffer> {
    // Generate random master key
    const masterKey = generateKey();

    // Encrypt master key with system key
    const encryptedMasterKey = this.encryptMasterKey(masterKey);

    // Generate salt
    const salt = generateSalt();

    // Store in database
    await this.db.collection<UserEncryptionKeyDocument>('user_encryption_keys').insertOne({
      _id: new ObjectId(),
      userId,
      encryptedMasterKey: encryptedMasterKey.toString('hex'),
      keyVersion: 1,
      salt: salt.toString('hex'),
      createdAt: new Date(),
    });

    return masterKey;
  }

  /**
   * Encrypt user's master key with system encryption key
   */
  private encryptMasterKey(masterKey: Buffer): Buffer {
    const systemKey = this.getSystemEncryptionKey();
    const encrypted = encrypt(masterKey.toString('hex'), systemKey);

    // Combine encrypted data, iv, and tag into single buffer
    return Buffer.concat([
      Buffer.from(encrypted.data, 'hex'),
      Buffer.from(encrypted.iv, 'hex'),
      Buffer.from(encrypted.tag, 'hex'),
    ]);
  }

  /**
   * Decrypt user's master key with system encryption key
   */
  private decryptMasterKey(encryptedMasterKey: string): Buffer {
    const systemKey = this.getSystemEncryptionKey();
    const combined = Buffer.from(encryptedMasterKey, 'hex');

    // Extract components (data is variable length, iv and tag are fixed)
    const tagLength = 16;
    const ivLength = 16;
    const dataLength = combined.length - ivLength - tagLength;

    const data = combined.subarray(0, dataLength);
    const iv = combined.subarray(dataLength, dataLength + ivLength);
    const tag = combined.subarray(dataLength + ivLength);

    const decrypted = decrypt(
      {
        data: data.toString('hex'),
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
      },
      systemKey,
    );

    return Buffer.from(decrypted, 'hex');
  }

  /**
   * Get system encryption key from secrets
   */
  private getSystemEncryptionKey(): Buffer {
    const encryptionSecret = secrets.requireSystem('encryption');
    return Buffer.from(encryptionSecret.masterKey, 'hex');
  }

  /**
   * Invalidate mcaId cache for an app
   */
  invalidateMcaIdCache(appId: string): void {
    this.mcaIdCache.delete(appId);
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.mcaIdCache.clear();
  }
}

// Export singleton (will be initialized with db in index.ts)
let authInstance: AuthManager | null = null;

export function initAuth(db: Db): AuthManager {
  authInstance = new AuthManager(db);
  return authInstance;
}

export function getAuth(): AuthManager {
  if (!authInstance) {
    throw new Error('Auth not initialized. Call initAuth(db) first.');
  }
  return authInstance;
}

// For convenience, export a getter
export const auth = {
  forUser: (userId: string) => getAuth().forUser(userId),
};
