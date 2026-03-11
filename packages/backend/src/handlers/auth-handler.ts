/**
 * Authentication Handler
 *
 * Handles WebSocket authentication:
 * - Password login (email + password)
 * - Token login (session token from previous login)
 * - Google OAuth init (returns URL for redirect)
 * - Registration
 */

import type { AuthMessage, UserId } from '@teros/shared';
import { type AuthService, getAuthService } from '../auth/auth-service';
import { type GoogleAuth, getGoogleAuth } from '../auth/google-auth';
import type { User } from '../auth/types';
import type { SessionManager } from '../services/session-manager';

export interface AuthResult {
  success: boolean;
  userId?: UserId;
  sessionToken?: string;
  user?: ClientUser;
  role?: string;
  error?: string;
  errorCode?: string;
  /** For OAuth: URL to redirect user to */
  redirectUrl?: string;
  /** OAuth URL (alias for redirectUrl) */
  url?: string;
  /** OAuth state token */
  state?: string;
  /** For account locked */
  lockedUntil?: Date;
}

/** User data safe to send to client */
export interface ClientUser {
  userId: string;
  profile: {
    displayName: string;
    email: string;
    avatarUrl?: string;
    locale?: string;
    timezone?: string;
  };
  status: string;
  role: string;
  emailVerified: boolean;
}

export class AuthHandler {
  private authService: AuthService | null = null;
  private googleAuth: GoogleAuth | null = null;

  constructor(private sessionManager: SessionManager) {}

  /**
   * Lazy init auth service (may not be available at construction time)
   */
  private getAuth(): AuthService {
    if (!this.authService) {
      this.authService = getAuthService();
    }
    return this.authService;
  }

  /**
   * Authenticate user with credentials, token, or OAuth
   */
  async authenticate(
    message: AuthMessage,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    // Handle different auth methods
    switch (message.method) {
      case 'credentials':
        return this.authenticateWithCredentials(message.email, message.password, metadata);

      case 'token':
        return this.authenticateWithToken(message.sessionToken);

      // Extended auth methods (need protocol update)
      default: {
        // Check for extended methods via type assertion
        const extendedMessage = message as any;

        if (extendedMessage.method === 'register') {
          // Registration via email/password is disabled — only OAuth is supported
          return {
            success: false,
            error: 'Registration via email/password is disabled. Please use Google to sign in.',
            errorCode: 'method_not_allowed',
          };
        }

        if (extendedMessage.method === 'google_init') {
          return this.initGoogleAuth();
        }

        return {
          success: false,
          error: `Unknown auth method: ${extendedMessage.method}`,
        };
      }
    }
  }

  /**
   * Authenticate with email/password
   */
  private async authenticateWithCredentials(
    email: string,
    password: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    try {
      const auth = this.getAuth();
      const result = await auth.loginWithPassword({
        email,
        password,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          lockedUntil: result.lockedUntil,
        };
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      };
    } catch (error) {
      console.error('[AuthHandler] Login error:', error);
      return {
        success: false,
        error: 'Authentication failed',
      };
    }
  }

  /**
   * Authenticate with session token
   */
  private async authenticateWithToken(token: string): Promise<AuthResult> {
    try {
      const auth = this.getAuth();
      const result = await auth.validateSession(token);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        };
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: token,
        user: this.toClientUser(result.user!),
      };
    } catch (error) {
      console.error('[AuthHandler] Token validation error:', error);
      return {
        success: false,
        error: 'Invalid session token',
      };
    }
  }

  /**
   * Register new user with email/password
   */
  private async register(
    email: string,
    password: string,
    displayName: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    try {
      const auth = this.getAuth();
      const result = await auth.register({
        email,
        password,
        displayName,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        };
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      };
    } catch (error) {
      console.error('[AuthHandler] Registration error:', error);
      return {
        success: false,
        error: 'Registration failed',
      };
    }
  }

  /**
   * Initialize Google OAuth flow
   * Returns URL for client to open in browser
   */
  async initGoogleOAuth(): Promise<AuthResult> {
    return this.initGoogleAuth();
  }

  /**
   * Initialize Google OAuth flow (internal)
   * Returns URL for client to open in browser
   */
  private async initGoogleAuth(): Promise<AuthResult> {
    const googleAuth = getGoogleAuth();

    if (!googleAuth) {
      return {
        success: false,
        error: 'Google authentication not configured',
      };
    }

    try {
      const { url, state } = await googleAuth.generateAuthUrl();

      return {
        success: true,
        redirectUrl: url,
        url,
        state,
      };
    } catch (error) {
      console.error('[AuthHandler] Google auth init error:', error);
      return {
        success: false,
        error: 'Failed to initialize Google authentication',
      };
    }
  }

  /**
   * Handle Google OAuth callback (called from HTTP handler)
   * Returns auth result that can be used to create WebSocket session
   */
  async handleGoogleCallback(
    code: string,
    state: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const googleAuth = getGoogleAuth();

    if (!googleAuth) {
      return {
        success: false,
        error: 'Google authentication not configured',
      };
    }

    try {
      // Complete OAuth flow
      const oauthResult = await googleAuth.completeOAuthFlow(code, state);

      if (!oauthResult.success) {
        return {
          success: false,
          error: oauthResult.error,
        };
      }

      const { userInfo, tokens } = oauthResult;

      // Login or create user via AuthService
      const auth = this.getAuth();
      const result = await auth.loginWithOAuth({
        provider: 'google',
        providerUserId: userInfo!.id,
        email: userInfo!.email,
        displayName: userInfo!.name,
        avatarUrl: userInfo!.picture,
        accessToken: tokens!.access_token,
        refreshToken: tokens!.refresh_token,
        tokenExpiresAt: tokens!.expires_in
          ? new Date(Date.now() + tokens!.expires_in * 1000)
          : undefined,
        providerProfile: {
          name: userInfo!.name,
          email: userInfo!.email,
          avatarUrl: userInfo!.picture,
          raw: userInfo,
        },
        scopes: tokens!.scope?.split(' '),
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      });

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        };
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      };
    } catch (error) {
      console.error('[AuthHandler] Google callback error:', error);
      return {
        success: false,
        error: 'Google authentication failed',
      };
    }
  }

  /**
   * Logout (revoke session)
   */
  async logout(token: string): Promise<boolean> {
    try {
      const auth = this.getAuth();
      return auth.logout(token);
    } catch (error) {
      console.error('[AuthHandler] Logout error:', error);
      return false;
    }
  }

  /**
   * Convert User to client-safe format
   */
  private toClientUser(user: User): ClientUser {
    return {
      userId: user.userId,
      profile: {
        displayName: user.profile.displayName,
        email: user.profile.email,
        avatarUrl: user.profile.avatarUrl,
        locale: user.profile.locale,
        timezone: user.profile.timezone,
      },
      status: user.status,
      role: user.role || 'user',
      emailVerified: user.emailVerified,
    };
  }
}
