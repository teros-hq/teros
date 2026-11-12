/**
 * Auth Manager
 *
 * Manages user credentials with per-user encryption
 */

import { type Db, ObjectId } from 'mongodb';
import type { UserCredentialDocument } from './types';
import { UserAuthContext } from './user-auth-context';
import { AAD_FORMAT, decryptForUser, encryptForUser } from './user-keys';

/** Bounded retries for merge() when another write lands in between (MOD-6). */
const MERGE_ATTEMPTS = 5;

const credentialScope = (appId: string) => `user_credentials:${appId}`;

export class AuthManager {
  private mcaIdCache: Map<string, string> = new Map();

  constructor(private db: Db) {}

  /** The one place `user_credentials` is opened (GOV-1 ratchet). */
  private get credentials() {
    return this.db.collection<UserCredentialDocument>('user_credentials');
  }

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
    await this.credentials
      .updateOne({ userId, appId }, { $set: { lastUsedAt: new Date() } });

    // Decrypt and return
    return this.decryptDoc(doc);
  }

  private decryptDoc(doc: UserCredentialDocument): Promise<any> {
    return decryptForUser(
      this.db,
      doc.userId,
      credentialScope(doc.appId),
      { data: doc.encryptedData, iv: doc.encryptionIv, tag: doc.encryptionTag },
      doc.encryptionFormat,
    );
  }

  /**
   * Set credentials for a user's app (full replace)
   */
  async set(userId: string, appId: string, mcaId: string, data: any): Promise<void> {
    await this.write(userId, appId, mcaId, data);
  }

  /**
   * Encrypt and upsert. With `expectedRev`, only writes if the stored rev
   * still matches (returns false otherwise) — merge()'s optimistic lock.
   */
  private async write(
    userId: string,
    appId: string,
    mcaId: string,
    data: any,
    expectedRev?: number | null,
  ): Promise<boolean> {
    const encrypted = await encryptForUser(this.db, userId, credentialScope(appId), data);
    const filter: Record<string, unknown> = { userId, appId };
    if (expectedRev !== undefined) filter.rev = expectedRev ?? { $exists: false };

    try {
      const res = await this.credentials.updateOne(
        filter,
        {
          $set: {
            mcaId,
            encryptedData: encrypted.data,
            encryptionIv: encrypted.iv,
            encryptionTag: encrypted.tag,
            encryptionFormat: AAD_FORMAT,
            updatedAt: new Date(),
          },
          $inc: { rev: 1 },
          $unset: {
            revokedAt: '',
          },
          $setOnInsert: {
            createdAt: new Date(),
            lastUsedAt: new Date(),
          },
        },
        // A conditional write must not upsert a duplicate when the rev moved
        { upsert: expectedRev === undefined || expectedRev === null },
      );
      return res.matchedCount > 0 || res.upsertedCount > 0;
    } catch (err) {
      // Lost an insert race on (userId, appId): the caller retries
      if (expectedRev !== undefined && (err as { code?: number }).code === 11000) return false;
      throw err;
    }
  }

  /**
   * Merge credentials for a user's app (partial update — preserves existing keys)
   * Reads current credentials, merges the new fields on top, then saves.
   */
  async merge(userId: string, appId: string, mcaId: string, patch: Record<string, any>): Promise<void> {
    // Optimistic concurrency (MOD-6): read + merge + write conditioned on the
    // rev we read. Two concurrent token refreshes used to both read the old
    // blob and the second write dropped the first one's rotated refresh token.
    for (let attempt = 0; attempt < MERGE_ATTEMPTS; attempt++) {
      const doc = await this.getCredentialDoc(userId, appId);
      const existing = doc && !doc.revokedAt ? await this.decryptDoc(doc) : {};
      // Merge: existing fields + patch (patch wins on conflict)
      const merged = { ...existing, ...patch };
      if (await this.write(userId, appId, mcaId, merged, doc ? (doc.rev ?? null) : null)) return;
    }
    throw new Error(`AuthManager.merge: concurrent updates kept conflicting for ${appId}`);
  }

  /**
   * Revoke credentials (mark as revoked)
   */
  async revoke(userId: string, appId: string): Promise<void> {
    await this.credentials
      .updateOne({ userId, appId }, { $set: { revokedAt: new Date() } });
  }

  /**
   * Get credential document (internal use)
   */
  async getCredentialDoc(userId: string, appId: string): Promise<UserCredentialDocument | null> {
    return this.credentials.findOne({
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

    // Apps are keyed by the string appId (app_…); only very old callers used
    // the ObjectId _id, which made new ObjectId('app_…') throw (MOD-8)
    const app = await this.db.collection('apps').findOne(
      ObjectId.isValid(appId) && appId.length === 24
        ? { $or: [{ appId }, { _id: new ObjectId(appId) }] }
        : { appId },
      { projection: { mcaId: 1 } },
    );

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
    const docs = await this.credentials
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
    const docs = await this.credentials
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
   * Decrypt every live credential stored for an MCA, across users and app
   * instances. Used when a secret has to be matched against an inbound value
   * instead of being looked up by (userId, appId) — e.g. the Teros Remote
   * gateway resolving a daemon's pasted key to its app instance (REQ-3).
   * Entries that fail to decrypt are skipped (crypto-shredded users, GOV-7).
   */
  async listCredentialsByMca(
    mcaId: string,
  ): Promise<Array<{ userId: string; appId: string; data: Record<string, unknown> }>> {
    const docs = await this.credentials
      .find({ mcaId, revokedAt: { $exists: false } })
      .toArray();
    const out: Array<{ userId: string; appId: string; data: Record<string, unknown> }> = [];
    for (const doc of docs) {
      try {
        const data = await this.decryptDoc(doc);
        if (data && typeof data === 'object') out.push({ userId: doc.userId, appId: doc.appId, data });
      } catch {
        // undecryptable (missing user key) — not a match, keep going
      }
    }
    return out;
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
