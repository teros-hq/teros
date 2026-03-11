/**
 * Session Service
 *
 * Manages user sessions (login tokens).
 * Sessions are long-lived (30 days) and can be revoked.
 */

import { createHash, randomBytes } from 'crypto';
import { type Collection, type Db, ObjectId } from 'mongodb';
import type { UserSession } from './types';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_BYTES = 32; // 256 bits

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
    // Find session by token hash
    await this.sessions.createIndex({ tokenHash: 1 }, { unique: true });
    // Find all sessions for a user
    await this.sessions.createIndex({ userId: 1 });
    // TTL index: automatically delete expired sessions
    await this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Find active sessions
    await this.sessions.createIndex({ status: 1, expiresAt: 1 });
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
      .catch(() => {}); // Ignore errors

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
