/**
 * Identity Service
 *
 * Manages user identities (authentication methods).
 * A user can have multiple identities: password, Google, GitHub, etc.
 */

import * as bcrypt from 'bcrypt';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type {
  IdentityProvider,
  OAuthIdentityData,
  PasswordIdentityData,
  UserIdentity,
} from './types';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export class IdentityService {
  private identities: Collection<UserIdentity>;

  constructor(private db: Db) {
    this.identities = db.collection<UserIdentity>('user_identities');
  }

  /**
   * Initialize indexes for the user_identities collection
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.identities, COLLECTIONS.userIdentities);
  }

  // ============================================================================
  // PASSWORD IDENTITY
  // ============================================================================

  /**
   * Create a password identity for a user
   */
  async createPasswordIdentity(params: {
    userId: string;
    email: string;
    password: string;
  }): Promise<UserIdentity> {
    const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
    const now = new Date();

    const identity: UserIdentity = {
      _id: new ObjectId(),
      userId: params.userId,
      type: 'password',
      providerUserId: params.email.toLowerCase(),
      email: params.email.toLowerCase(),
      data: {
        passwordHash,
        failedAttempts: 0,
        lastPasswordChangeAt: now,
      } as PasswordIdentityData,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.identities.insertOne(identity);
    return identity;
  }

  /**
   * Verify password for a password identity
   * Returns the identity if valid, null if invalid
   * Handles failed attempts and lockout
   */
  async verifyPassword(
    email: string,
    password: string,
  ): Promise<{
    success: boolean;
    identity?: UserIdentity;
    error?: 'invalid_credentials' | 'account_locked' | 'identity_not_found' | 'identity_revoked';
    lockedUntil?: Date;
  }> {
    const identity = await this.identities.findOne({
      type: 'password',
      providerUserId: email.toLowerCase(),
    });

    if (!identity) {
      return { success: false, error: 'identity_not_found' };
    }

    if (identity.status === 'revoked') {
      return { success: false, error: 'identity_revoked' };
    }

    const data = identity.data as PasswordIdentityData;

    // Check if account is currently locked
    if (data.lockedUntil && data.lockedUntil > new Date()) {
      return {
        success: false,
        error: 'account_locked',
        lockedUntil: data.lockedUntil,
      };
    }

    // Verify password
    const isValid = await bcrypt.compare(password, data.passwordHash);

    if (!isValid) {
      const lockedUntil = await this.recordFailedAttempt(identity._id);
      return {
        success: false,
        error: 'invalid_credentials',
        lockedUntil: lockedUntil ?? undefined,
      };
    }

    // Success: reset failed attempts and update lastUsedAt
    await this.identities.updateOne(
      { _id: identity._id },
      {
        $set: {
          'data.failedAttempts': 0,
          'data.lockedUntil': null,
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    return { success: true, identity };
  }

  /**
   * Count a failed password attempt and lock the identity at MAX_FAILED_ATTEMPTS.
   *
   * One pipeline update computes the new counter from the stored value, so
   * concurrent wrong guesses can't overwrite each other's increment (MOD-6:
   * read-then-$set let parallel attempts be under-counted, weakening the
   * lockout). Returns the lock expiry, or null when not locked.
   */
  private async recordFailedAttempt(identityId: ObjectId): Promise<Date | null> {
    const now = new Date();
    // A lockout that has already elapsed starts a fresh attempt window.
    // Otherwise the counter stays at MAX and a single mistake by a legitimate
    // user who waited out the lockout re-locks them immediately. OWASP: the
    // failed-attempt counter resets once the lockout duration passes
    // (Authentication Cheat Sheet). (TER-450)
    const lockoutElapsed = {
      $lte: [{ $ifNull: ['$data.lockedUntil', new Date(8640000000000000)] }, now],
    };

    const updated = await this.identities.findOneAndUpdate(
      { _id: identityId },
      [
        {
          $set: {
            'data.failedAttempts': {
              $add: [{ $cond: [lockoutElapsed, 0, { $ifNull: ['$data.failedAttempts', 0] }] }, 1],
            },
          },
        },
        {
          $set: {
            // Lock on too many failures; otherwise clear any stale lockout
            'data.lockedUntil': {
              $cond: [
                { $gte: ['$data.failedAttempts', MAX_FAILED_ATTEMPTS] },
                new Date(now.getTime() + LOCKOUT_DURATION_MS),
                null,
              ],
            },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );

    return (updated?.data as PasswordIdentityData | undefined)?.lockedUntil ?? null;
  }

  /**
   * Change password for a password identity
   */
  async changePassword(userId: string, newPassword: string): Promise<boolean> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    const result = await this.identities.updateOne(
      { userId, type: 'password', status: 'active' },
      {
        $set: {
          'data.passwordHash': passwordHash,
          'data.failedAttempts': 0,
          'data.lockedUntil': null,
          'data.lastPasswordChangeAt': new Date(),
          updatedAt: new Date(),
        },
      },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Store a hashed password reset token on the identity.
   * The token is hashed (sha256) before storage — never kept in plaintext.
   */
  async setPasswordResetToken(identityId: ObjectId, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.identities.updateOne(
      { _id: identityId },
      {
        $set: {
          'data.resetToken': tokenHash,
          'data.resetTokenExpiresAt': expiresAt,
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Clear the password reset token after a successful reset.
   */
  async clearPasswordResetToken(identityId: ObjectId): Promise<void> {
    await this.identities.updateOne(
      { _id: identityId },
      {
        $unset: {
          'data.resetToken': '',
          'data.resetTokenExpiresAt': '',
        },
        $set: {
          updatedAt: new Date(),
        },
      },
    );
  }

  // ============================================================================
  // OAUTH IDENTITY
  // ============================================================================

  /**
   * Create or update an OAuth identity (profile and scopes).
   *
   * The provider's access/refresh tokens are NOT stored (SEC-4): sign-in only
   * needs the verified identity, nothing ever read them back, and they sat in
   * plaintext. Updating an identity also removes any stored by older code.
   */
  async upsertOAuthIdentity(params: {
    userId: string;
    type: Exclude<IdentityProvider, 'password'>;
    providerUserId: string;
    email: string;
    providerProfile: OAuthIdentityData['providerProfile'];
    scopes?: string[];
  }): Promise<UserIdentity> {
    const now = new Date();

    const existingIdentity = await this.identities.findOne({
      type: params.type,
      providerUserId: params.providerUserId,
    });

    if (existingIdentity) {
      // Update existing identity
      await this.identities.updateOne(
        { _id: existingIdentity._id },
        {
          $set: {
            email: params.email.toLowerCase(),
            'data.providerProfile': params.providerProfile,
            'data.scopes': params.scopes,
            lastUsedAt: now,
            updatedAt: now,
          },
          $unset: { 'data.accessToken': '', 'data.refreshToken': '', 'data.tokenExpiresAt': '' },
        },
      );

      return (await this.identities.findOne({ _id: existingIdentity._id }))!;
    }

    // Create new identity
    const identity: UserIdentity = {
      _id: new ObjectId(),
      userId: params.userId,
      type: params.type,
      providerUserId: params.providerUserId,
      email: params.email.toLowerCase(),
      data: {
        providerProfile: params.providerProfile,
        scopes: params.scopes,
      } as OAuthIdentityData,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
    };

    await this.identities.insertOne(identity);
    return identity;
  }

  // ============================================================================
  // COMMON OPERATIONS
  // ============================================================================

  /**
   * Get identity by ID
   */
  async getById(identityId: ObjectId): Promise<UserIdentity | null> {
    return this.identities.findOne({ _id: identityId });
  }

  /**
   * Get all identities for a user
   */
  async getByUserId(userId: string): Promise<UserIdentity[]> {
    return this.identities
      .find({
        userId,
        status: 'active',
      })
      .toArray();
  }

  /**
   * Find identity by provider and provider user ID
   */
  async getByProvider(
    type: IdentityProvider,
    providerUserId: string,
  ): Promise<UserIdentity | null> {
    return this.identities.findOne({
      type,
      providerUserId: type === 'password' ? providerUserId.toLowerCase() : providerUserId,
    });
  }

  /**
   * Find identity by provider and email
   * Useful for linking: "is there already a Google identity with this email?"
   */
  async getByProviderEmail(type: IdentityProvider, email: string): Promise<UserIdentity | null> {
    return this.identities.findOne({
      type,
      email: email.toLowerCase(),
    });
  }

  /**
   * Find any identity with this email (for auto-linking)
   */
  async getAnyByEmail(email: string): Promise<UserIdentity | null> {
    return this.identities.findOne({
      email: email.toLowerCase(),
      status: 'active',
    });
  }

  /**
   * Revoke an identity
   */
  async revokeIdentity(identityId: ObjectId): Promise<void> {
    await this.identities.updateOne(
      { _id: identityId },
      {
        $set: {
          status: 'revoked',
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Update lastUsedAt for an identity
   */
  async touchIdentity(identityId: ObjectId): Promise<void> {
    await this.identities.updateOne(
      { _id: identityId },
      {
        $set: {
          lastUsedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );
  }

  /**
   * Check if user has a password identity with an actual password hash.
   * An identity without a hash (e.g. created by a script or migration without
   * setting a password) should NOT count — the user can't verify with it.
   */
  async hasPasswordIdentity(userId: string): Promise<boolean> {
    const identity = await this.identities.findOne({
      userId,
      type: 'password',
      status: 'active',
      'data.passwordHash': { $exists: true, $ne: null },
    });
    return identity !== null;
  }

  /**
   * Count identities for a user
   */
  /** Whether the user has any identity at all, active or revoked. */
  async hasAnyIdentity(userId: string): Promise<boolean> {
    return (await this.identities.countDocuments({ userId }, { limit: 1 })) > 0;
  }

  async countIdentities(userId: string): Promise<number> {
    return this.identities.countDocuments({
      userId,
      status: 'active',
    });
  }
}
