/**
 * Identity Service
 *
 * Manages user identities (authentication methods).
 * A user can have multiple identities: password, Google, GitHub, etc.
 */

import * as bcrypt from 'bcrypt';
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
    // Unique: one identity per provider+providerUserId
    await this.identities.createIndex({ type: 1, providerUserId: 1 }, { unique: true });
    // Find all identities for a user
    await this.identities.createIndex({ userId: 1 });
    // Find identity by email (for linking)
    await this.identities.createIndex({ type: 1, email: 1 });
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

    // Check if account is locked
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
      // Increment failed attempts
      const newFailedAttempts = data.failedAttempts + 1;
      const updates: Partial<PasswordIdentityData> = {
        failedAttempts: newFailedAttempts,
      };

      // Lock account if too many failures
      if (newFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
      }

      await this.identities.updateOne(
        { _id: identity._id },
        {
          $set: {
            'data.failedAttempts': updates.failedAttempts,
            ...(updates.lockedUntil && { 'data.lockedUntil': updates.lockedUntil }),
            updatedAt: new Date(),
          },
        },
      );

      return {
        success: false,
        error: 'invalid_credentials',
        lockedUntil: updates.lockedUntil,
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

  // ============================================================================
  // OAUTH IDENTITY
  // ============================================================================

  /**
   * Create or update an OAuth identity
   * If identity exists, updates tokens and profile
   * If not, creates new identity
   */
  async upsertOAuthIdentity(params: {
    userId: string;
    type: Exclude<IdentityProvider, 'password'>;
    providerUserId: string;
    email: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: Date;
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
            'data.accessToken': params.accessToken,
            'data.refreshToken': params.refreshToken,
            'data.tokenExpiresAt': params.tokenExpiresAt,
            'data.providerProfile': params.providerProfile,
            'data.scopes': params.scopes,
            lastUsedAt: now,
            updatedAt: now,
          },
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
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
        tokenExpiresAt: params.tokenExpiresAt,
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
   * Check if user has a password identity
   */
  async hasPasswordIdentity(userId: string): Promise<boolean> {
    const identity = await this.identities.findOne({
      userId,
      type: 'password',
      status: 'active',
    });
    return identity !== null;
  }

  /**
   * Count identities for a user
   */
  async countIdentities(userId: string): Promise<number> {
    return this.identities.countDocuments({
      userId,
      status: 'active',
    });
  }
}
