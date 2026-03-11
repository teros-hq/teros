/**
 * Auth Service
 *
 * Main authentication orchestrator.
 * Coordinates UserService, IdentityService, and SessionService
 * to handle registration, login, and session management.
 */

import type { Db, ObjectId } from 'mongodb';
import { DefaultAgentService } from './default-agent-service';
import { IdentityService } from './identity-service';
import { SessionService, type SessionWithToken } from './session-service';
import type { IdentityProvider, OAuthIdentityData, User, UserIdentity, UserSession } from './types';
import { UserService } from './user-service';

export interface AuthResult {
  success: boolean;
  user?: User;
  session?: SessionWithToken;
  error?: string;
  errorCode?:
    | 'invalid_credentials'
    | 'account_locked'
    | 'account_suspended'
    | 'email_exists'
    | 'identity_not_found'
    | 'identity_revoked'
    | 'invalid_token'
    | 'session_expired';
  lockedUntil?: Date;
}

export interface RegisterParams {
  email: string;
  password: string;
  displayName: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface LoginParams {
  email: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface OAuthLoginParams {
  provider: Exclude<IdentityProvider, 'password'>;
  providerUserId: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: Date;
  providerProfile?: OAuthIdentityData['providerProfile'];
  scopes?: string[];
  userAgent?: string;
  ipAddress?: string;
}

export class AuthService {
  private userService: UserService;
  private identityService: IdentityService;
  private sessionService: SessionService;
  private defaultAgentService: DefaultAgentService;

  constructor(private db: Db) {
    this.userService = new UserService(db);
    this.identityService = new IdentityService(db);
    this.sessionService = new SessionService(db);
    this.defaultAgentService = new DefaultAgentService(db);
  }

  /**
   * Initialize all auth-related indexes
   */
  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.userService.ensureIndexes(),
      this.identityService.ensureIndexes(),
      this.sessionService.ensureIndexes(),
    ]);
    console.log('[AuthService] Database indexes ensured');
  }

  // ============================================================================
  // REGISTRATION
  // ============================================================================

  /**
   * Register a new user with email/password
   */
  async register(params: RegisterParams): Promise<AuthResult> {
    const email = params.email.toLowerCase();

    // Check if email already exists
    if (await this.userService.emailExists(email)) {
      return {
        success: false,
        error: 'Email already registered',
        errorCode: 'email_exists',
      };
    }

    // Also check identities (in case of partial registration)
    const existingIdentity = await this.identityService.getByProvider('password', email);
    if (existingIdentity) {
      return {
        success: false,
        error: 'Email already registered',
        errorCode: 'email_exists',
      };
    }

    // Create user
    const user = await this.userService.createUser({
      email,
      displayName: params.displayName,
      emailVerified: false,
    });

    // Create password identity
    const identity = await this.identityService.createPasswordIdentity({
      userId: user.userId,
      email,
      password: params.password,
    });

    // Create session
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);

    // Create default agent if user has none
    await this.defaultAgentService.createDefaultAgentIfNeeded(user.userId);

    return {
      success: true,
      user,
      session,
    };
  }

  // ============================================================================
  // PASSWORD LOGIN
  // ============================================================================

  /**
   * Login with email/password
   */
  async loginWithPassword(params: LoginParams): Promise<AuthResult> {
    const email = params.email.toLowerCase();

    // Verify password
    const verifyResult = await this.identityService.verifyPassword(email, params.password);

    if (!verifyResult.success) {
      return {
        success: false,
        error: this.getErrorMessage(verifyResult.error!),
        errorCode: verifyResult.error,
        lockedUntil: verifyResult.lockedUntil,
      };
    }

    const identity = verifyResult.identity!;

    // Get user
    const user = await this.userService.getByUserId(identity.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        errorCode: 'identity_not_found',
      };
    }

    // Check user status
    if (user.status === 'suspended') {
      return {
        success: false,
        error: 'Account suspended',
        errorCode: 'account_suspended',
      };
    }

    // Create session
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);

    return {
      success: true,
      user,
      session,
    };
  }

  // ============================================================================
  // OAUTH LOGIN
  // ============================================================================

  /**
   * Login or register with OAuth provider (Google, GitHub, etc.)
   *
   * Flow:
   * 1. Check if identity exists → login
   * 2. Check if email exists in another user → link identity
   * 3. Otherwise → create new user + identity
   */
  async loginWithOAuth(params: OAuthLoginParams): Promise<AuthResult> {
    const email = params.email.toLowerCase();

    // Check if this OAuth identity already exists
    const existingIdentity = await this.identityService.getByProvider(
      params.provider,
      params.providerUserId,
    );

    if (existingIdentity) {
      // Identity exists → update and login
      return this.loginExistingOAuthIdentity(existingIdentity, params);
    }

    // Check if email exists in any identity (for auto-linking)
    const identityWithEmail = await this.identityService.getAnyByEmail(email);

    if (identityWithEmail) {
      // Email exists → link new identity to existing user
      return this.linkOAuthIdentity(identityWithEmail.userId, params);
    }

    // New user → create user + identity
    return this.createOAuthUser(params);
  }

  /**
   * Login with existing OAuth identity
   */
  private async loginExistingOAuthIdentity(
    identity: UserIdentity,
    params: OAuthLoginParams,
  ): Promise<AuthResult> {
    // Update identity with fresh tokens/profile
    await this.identityService.upsertOAuthIdentity({
      userId: identity.userId,
      type: params.provider,
      providerUserId: params.providerUserId,
      email: params.email,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      tokenExpiresAt: params.tokenExpiresAt,
      providerProfile: params.providerProfile || { email: params.email },
      scopes: params.scopes,
    });

    // Get user
    const user = await this.userService.getByUserId(identity.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        errorCode: 'identity_not_found',
      };
    }

    // Check user status
    if (user.status === 'suspended') {
      return {
        success: false,
        error: 'Account suspended',
        errorCode: 'account_suspended',
      };
    }

    // Create session
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login and maybe avatar
    await this.userService.updateLastLogin(user.userId);
    if (params.avatarUrl && !user.profile.avatarUrl) {
      await this.userService.updateProfile(user.userId, { avatarUrl: params.avatarUrl });
    }

    return {
      success: true,
      user: (await this.userService.getByUserId(user.userId)) || user,
      session,
    };
  }

  /**
   * Link OAuth identity to existing user (auto-link by email)
   */
  private async linkOAuthIdentity(userId: string, params: OAuthLoginParams): Promise<AuthResult> {
    // Create new identity linked to existing user
    const identity = await this.identityService.upsertOAuthIdentity({
      userId,
      type: params.provider,
      providerUserId: params.providerUserId,
      email: params.email,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      tokenExpiresAt: params.tokenExpiresAt,
      providerProfile: params.providerProfile || { email: params.email },
      scopes: params.scopes,
    });

    // Get user
    const user = await this.userService.getByUserId(userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        errorCode: 'identity_not_found',
      };
    }

    // Check user status
    if (user.status === 'suspended') {
      return {
        success: false,
        error: 'Account suspended',
        errorCode: 'account_suspended',
      };
    }

    // Create session
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);

    console.log(`[AuthService] Linked ${params.provider} identity to existing user ${userId}`);

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Create new user with OAuth identity
   */
  private async createOAuthUser(params: OAuthLoginParams): Promise<AuthResult> {
    // Create user
    const user = await this.userService.createUser({
      email: params.email,
      displayName: params.displayName,
      avatarUrl: params.avatarUrl,
      emailVerified: true, // OAuth emails are verified by provider
    });

    // Create OAuth identity
    const identity = await this.identityService.upsertOAuthIdentity({
      userId: user.userId,
      type: params.provider,
      providerUserId: params.providerUserId,
      email: params.email,
      accessToken: params.accessToken,
      refreshToken: params.refreshToken,
      tokenExpiresAt: params.tokenExpiresAt,
      providerProfile: params.providerProfile || { email: params.email },
      scopes: params.scopes,
    });

    // Create session
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);

    // Create default agent if user has none
    await this.defaultAgentService.createDefaultAgentIfNeeded(user.userId);

    // Send welcome email (fire-and-forget)
    try {
      const { isEmailConfigured, getEmailService } = await import('../services/email-service');
      if (isEmailConfigured()) {
        getEmailService().sendWelcomeRegistered(user.profile.email, {
          USER_NAME: user.profile.displayName,
        }).catch((e) => console.error('[AuthService] Failed to send welcome email:', e));
      }
    } catch (e) {
      console.error('[AuthService] Email service not available:', e);
    }

    console.log(`[AuthService] Created new user ${user.userId} with ${params.provider} identity`);

    return {
      success: true,
      user,
      session,
    };
  }

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================

  /**
   * Validate a session token
   */
  async validateSession(token: string): Promise<AuthResult> {
    const session = await this.sessionService.validateToken(token);

    if (!session) {
      return {
        success: false,
        error: 'Invalid or expired session',
        errorCode: 'invalid_token',
      };
    }

    const user = await this.userService.getByUserId(session.userId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
        errorCode: 'identity_not_found',
      };
    }

    if (user.status === 'suspended') {
      return {
        success: false,
        error: 'Account suspended',
        errorCode: 'account_suspended',
      };
    }

    return {
      success: true,
      user,
      session: { session, token },
    };
  }

  /**
   * Logout (revoke session)
   */
  async logout(token: string): Promise<boolean> {
    return this.sessionService.revokeSession(token, 'logout');
  }

  /**
   * Logout all sessions for a user
   */
  async logoutAll(userId: string, exceptToken?: string): Promise<number> {
    let exceptSessionId: ObjectId | undefined;

    if (exceptToken) {
      const session = await this.sessionService.validateToken(exceptToken);
      exceptSessionId = session?._id;
    }

    return this.sessionService.revokeAllUserSessions(userId, 'logout', exceptSessionId);
  }

  /**
   * Change password (and revoke all other sessions)
   */
  async changePassword(
    userId: string,
    newPassword: string,
    currentToken?: string,
  ): Promise<boolean> {
    const success = await this.identityService.changePassword(userId, newPassword);

    if (success) {
      // Revoke all sessions except current
      let exceptSessionId: ObjectId | undefined;
      if (currentToken) {
        const session = await this.sessionService.validateToken(currentToken);
        exceptSessionId = session?._id;
      }
      await this.sessionService.revokeAllUserSessions(userId, 'password_change', exceptSessionId);
    }

    return success;
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Get error message for error code
   */
  private getErrorMessage(code: string): string {
    switch (code) {
      case 'invalid_credentials':
        return 'Invalid email or password';
      case 'account_locked':
        return 'Account temporarily locked due to too many failed attempts';
      case 'identity_not_found':
        return 'No account found with this email';
      case 'identity_revoked':
        return 'This login method has been disabled';
      default:
        return 'Authentication failed';
    }
  }

  /**
   * Get services for advanced operations
   */
  get users(): UserService {
    return this.userService;
  }

  get identities(): IdentityService {
    return this.identityService;
  }

  get sessions(): SessionService {
    return this.sessionService;
  }
}

// Singleton instance
let authServiceInstance: AuthService | null = null;

export function initAuthService(db: Db): AuthService {
  authServiceInstance = new AuthService(db);
  return authServiceInstance;
}

export function getAuthService(): AuthService {
  if (!authServiceInstance) {
    throw new Error('AuthService not initialized. Call initAuthService(db) first.');
  }
  return authServiceInstance;
}
