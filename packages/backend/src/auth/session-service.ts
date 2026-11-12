/**
 * Session Service
 *
 * Manages user sessions (login tokens).
 * Sessions are long-lived (30 days) and can be revoked.
 */

import { createHash, randomBytes } from 'crypto';
import { COLLECTIONS, ensureCollectionIndexes } from '../db';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { UserSession } from './types';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const IMPERSONATION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours
const TOKEN_BYTES = 32; // 256 bits

/**
 * Step-up authentication window (Req 2.4.1).
 * After re-authenticating, the user can perform sensitive operations
 * for this duration before needing to re-authenticate again.
 */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a secure random session token
 */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hash a token for storage
 * We never store the actual token, only its hash
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateSessionParams {
  userId: string;
  identityId: ObjectId;
  userAgent?: string;
  ipAddress?: string;
}

export interface CreateImpersonationSessionParams {
  /** The target user being impersonated */
  targetUserId: string;
  /** The admin's userId (e.g. "user:abc123") */
  adminUserId: string;
  /** The admin's display name */
  adminDisplayName: string;
  /** SHA-256 hash of the admin's current token */
  originalTokenHash: string;
  /** Identity to associate with the new session (use admin's identityId) */
  identityId: ObjectId;
  userAgent?: string;
  ipAddress?: string;
}

/** Hash a token for storage (exported so handlers can hash tokens too) */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionWithToken {
  session: UserSession;
  token: string; // The actual token (only returned on creation)
}

export class SessionService {
  private sessions: Collection<UserSession>;

  constructor(private db: Db) {
    this.sessions = db.collection<UserSession>('user_sessions');
  }

  /**
   * Initialize indexes for the user_sessions collection
   */
  async ensureIndexes(): Promise<void> {
    // Declared in src/db/indexes.ts (GOV-4); boot applies the whole registry with
    // ensureAllIndexes after migrations. Kept for tests and scripts.
    await ensureCollectionIndexes(this.sessions, COLLECTIONS.userSessions);
  }

  /**
   * Create a new session
   * Returns both the session document and the actual token
   */
  async createSession(params: CreateSessionParams): Promise<SessionWithToken> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

    // Parse user agent for device info
    const deviceInfo = this.parseUserAgent(params.userAgent);

    const session: UserSession = {
      _id: new ObjectId(),
      userId: params.userId,
      identityId: params.identityId,
      tokenHash,
      metadata: {
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
        ...deviceInfo,
      },
      expiresAt,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    };

    await this.sessions.insertOne(session);

    return { session, token };
  }

  /**
   * Validate a session token
   * Returns the session if valid, null if invalid/expired/revoked
   */
  async validateToken(token: string): Promise<UserSession | null> {
    const tokenHash = hashToken(token);

    const session = await this.sessions.findOne({
      tokenHash,
      status: 'active',
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      return null;
    }

    // Update last activity (fire and forget)
    this.sessions
      .updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date() } })
      .catch(() => {}); // intentional: fire-and-forget activity update — must not block auth flow

    return session;
  }

  /**
   * Refresh a session (extend expiration)
   * Returns new token if successful
   */
  async refreshSession(token: string): Promise<SessionWithToken | null> {
    const tokenHash = hashToken(token);

    const session = await this.sessions.findOne({
      tokenHash,
      status: 'active',
    });

    if (!session) {
      return null;
    }

    // Generate new token
    const newToken = generateToken();
    const newTokenHash = hashToken(newToken);
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

    await this.sessions.updateOne(
      { _id: session._id },
      {
        $set: {
          tokenHash: newTokenHash,
          expiresAt: newExpiresAt,
          lastActivityAt: now,
        },
      },
    );

    const updatedSession = await this.sessions.findOne({ _id: session._id });

    return {
      session: updatedSession!,
      token: newToken,
    };
  }

  /**
   * Refresh a session by its token hash (used when the plaintext token is unavailable).
   * Generates a new token and updates the session. Returns the new token.
   */
  async refreshSessionByHash(tokenHash: string): Promise<SessionWithToken | null> {
    const session = await this.sessions.findOne({
      tokenHash,
      status: 'active',
    });

    if (!session) {
      return null;
    }

    const newToken = generateToken();
    const newTokenHash = hashToken(newToken);
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + SESSION_DURATION_MS);

    await this.sessions.updateOne(
      { _id: session._id },
      {
        $set: {
          tokenHash: newTokenHash,
          expiresAt: newExpiresAt,
          lastActivityAt: now,
        },
      },
    );

    const updatedSession = await this.sessions.findOne({ _id: session._id });

    return {
      session: updatedSession!,
      token: newToken,
    };
  }

  /**
   * Revoke a session (logout)
   */
  async revokeSession(
    token: string,
    reason: UserSession['revokedReason'] = 'logout',
  ): Promise<boolean> {
    const tokenHash = hashToken(token);

    const result = await this.sessions.updateOne(
      { tokenHash, status: 'active' },
      {
        $set: {
          status: 'revoked',
          revokedAt: new Date(),
          revokedReason: reason,
        },
      },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Revoke all sessions for a user
   * Useful when changing password or for security
   */
  async revokeAllUserSessions(
    userId: string,
    reason: UserSession['revokedReason'] = 'security',
    exceptSessionId?: ObjectId,
  ): Promise<number> {
    const filter: any = {
      userId,
      status: 'active',
    };

    if (exceptSessionId) {
      filter._id = { $ne: exceptSessionId };
    }

    const result = await this.sessions.updateMany(filter, {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    return result.modifiedCount;
  }

  /**
   * Get all active sessions for a user
   */
  async getUserSessions(userId: string): Promise<UserSession[]> {
    return this.sessions
      .find({
        userId,
        status: 'active',
        expiresAt: { $gt: new Date() },
      })
      .sort({ lastActivityAt: -1 })
      .toArray();
  }

  /**
   * Get session by ID
   */
  async getById(sessionId: ObjectId): Promise<UserSession | null> {
    return this.sessions.findOne({ _id: sessionId });
  }

  /**
   * Get an active session by its token hash.
   * Used by impersonation handlers to look up the admin's original session.
   */
  async getByTokenHash(tokenHash: string): Promise<UserSession | null> {
    return this.sessions.findOne({
      tokenHash,
      status: 'active',
      expiresAt: { $gt: new Date() },
    });
  }

  /**
   * Create an impersonation session for a target user.
   * The session has a 2-hour TTL and carries metadata linking it back to the
   * admin's original session (via originalTokenHash).
   */
  async createImpersonationSession(
    params: CreateImpersonationSessionParams,
  ): Promise<SessionWithToken> {
    const token = generateToken();
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + IMPERSONATION_DURATION_MS);

    const session: UserSession = {
      _id: new ObjectId(),
      userId: params.targetUserId,
      identityId: params.identityId,
      tokenHash,
      metadata: {
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
        isImpersonating: true,
        impersonatedBy: params.adminUserId,
        impersonatedByName: params.adminDisplayName,
        originalTokenHash: params.originalTokenHash,
      },
      expiresAt,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    };

    await this.sessions.insertOne(session);

    return { session, token };
  }

  /**
   * Count active sessions for a user
   */
  async countActiveSessions(userId: string): Promise<number> {
    return this.sessions.countDocuments({
      userId,
      status: 'active',
      expiresAt: { $gt: new Date() },
    });
  }

  /**
   * Parse user agent string for device info
   */
  private parseUserAgent(userAgent?: string): {
    deviceType?: 'desktop' | 'mobile' | 'tablet' | 'unknown';
    os?: string;
    browser?: string;
  } {
    if (!userAgent) {
      return { deviceType: 'unknown' };
    }

    const ua = userAgent.toLowerCase();

    // Device type
    let deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown' = 'unknown';
    if (ua.includes('mobile') || (ua.includes('android') && !ua.includes('tablet'))) {
      deviceType = 'mobile';
    } else if (ua.includes('tablet') || ua.includes('ipad')) {
      deviceType = 'tablet';
    } else if (ua.includes('windows') || ua.includes('macintosh') || ua.includes('linux')) {
      deviceType = 'desktop';
    }

    // OS
    let os: string | undefined;
    if (ua.includes('windows')) os = 'Windows';
    else if (ua.includes('macintosh') || ua.includes('mac os')) os = 'macOS';
    else if (ua.includes('linux')) os = 'Linux';
    else if (ua.includes('android')) os = 'Android';
    else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';

    // Browser
    let browser: string | undefined;
    if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
    else if (ua.includes('firefox')) browser = 'Firefox';
    else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
    else if (ua.includes('edg')) browser = 'Edge';

    return { deviceType, os, browser };
  }

  // ===========================================================================
  // STEP-UP AUTHENTICATION (Req 2.4.1)
  // ===========================================================================

  /**
   * Mark the current session as step-up authenticated.
   * Called after the user re-verifies their identity (password or TOTP).
   * Sets `metadata.stepUpAt` to the current time.
   */
  async setStepUp(tokenHash: string): Promise<boolean> {
    const result = await this.sessions.updateOne(
      { tokenHash, status: 'active', expiresAt: { $gt: new Date() } },
      {
        $set: {
          'metadata.stepUpAt': new Date(),
          lastActivityAt: new Date(),
        },
      },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Check whether the session has a valid (recent) step-up authentication.
   * Returns true if `metadata.stepUpAt` exists and is within STEP_UP_WINDOW_MS.
   */
  hasValidStepUp(session: UserSession): boolean {
    const stepUpAt = session.metadata?.stepUpAt;
    if (!stepUpAt) {
      return false;
    }
    const elapsed = Date.now() - new Date(stepUpAt).getTime();
    return elapsed >= 0 && elapsed < STEP_UP_WINDOW_MS;
  }

  /**
   * Clean up expired sessions (in case TTL index is slow)
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.sessions.deleteMany({
      expiresAt: { $lt: new Date() },
    });
    return result.deletedCount;
  }
}
