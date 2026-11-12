/**
 * Authentication Handler
 *
 * Handles WebSocket authentication:
 * - Password login (email + password)
 * - Token login (session token from previous login)
 * - Google OAuth init (returns URL for redirect)
 * - Registration
 * - Dev auto-login (local development only, see auth/dev-autologin.ts)
 */

import type { AuthMessage, UserId } from "@teros/shared"
import { TEROS_EDITION, type TerosEdition } from "@teros/shared"
import { type AuthService, getAuthService } from "../auth/auth-service"
import { resolveApiToken } from "../auth/api-tokens"
import { getDevAutologin } from "../auth/dev-autologin"
import { type GoogleAuth, getGoogleAuth } from "../auth/google-auth"
import { type GitHubAuth, getGitHubAuth } from "../auth/github-auth"
import { type MicrosoftAuth, getMicrosoftAuth } from "../auth/microsoft-auth"
import { toIsoString, type User } from "../auth/types"
import type { SessionManager } from "../services/session-manager"
import type { Db } from "mongodb"
import { captureException } from "../lib/sentry"

export interface AuthResult {
  success: boolean
  userId?: UserId
  sessionToken?: string
  user?: ClientUser
  role?: string
  error?: string
  errorCode?: string
  /** Session expiry (ISO string) — surfaced by GET /auth/session state (F2) */
  sessionExpiresAt?: string
  /** For OAuth: URL to redirect user to */
  redirectUrl?: string
  /** OAuth URL (alias for redirectUrl) */
  url?: string
  /** OAuth state token */
  state?: string
  /** For account locked */
  lockedUntil?: Date
  /** Present when the session is an impersonation session */
  impersonation?: {
    isImpersonating: true
    impersonatedBy: string
    impersonatedByName: string
  }
  /** Present when MFA verification is required to complete login */
  mfaChallenge?: {
    userId: string
    challengeToken: string
  }
  /** Present when the emailed code must be entered to complete login */
  emailVerification?: {
    challengeToken: string
    email: string
  }
  /** Present when a password reset code has been sent */
  passwordReset?: {
    challengeToken: string
    email: string
    codeVerified?: boolean
  }
}

/** User data safe to send to client */
export interface ClientUser {
  userId: string
  profile: {
    displayName: string
    email: string
    avatarUrl?: string
    locale?: string
    timezone?: string
  }
  status: string
  role: string
  emailVerified: boolean
  termsAcceptedAt?: string
  onboardingCompletedAt?: string
  accessGranted?: boolean
  /** Deployment edition (ONB-REQ-1): sent with every auth result so the app knows it before the first screen. */
  edition: TerosEdition
}

export class AuthHandler {
  private authService: AuthService | null = null
  private googleAuth: GoogleAuth | null = null

  constructor(private sessionManager: SessionManager, private db?: Db) {}

  /**
   * Lazy init auth service (may not be available at construction time)
   */
  private getAuth(): AuthService {
    if (!this.authService) {
      this.authService = getAuthService()
    }
    return this.authService
  }

  /**
   * Authenticate user with credentials, token, or OAuth
   */
  async authenticate(
    message: AuthMessage,
    metadata?: {
      userAgent?: string
      ipAddress?: string
      /** The connection passed isDevAutologinRequestAllowed (set by the WS handler) */
      devAutologin?: boolean
    },
  ): Promise<AuthResult> {
    // Handle different auth methods
    switch (message.method) {
      case "credentials":
        return this.authenticateWithCredentials(message.email, message.password, metadata)

      case "token":
        return this.authenticateWithToken(message.sessionToken)

      case "dev":
        // Off (prod, or a non-local connection): answer exactly like any
        // unknown method, so the dev path is indistinguishable from absent.
        if (metadata?.devAutologin !== true) {
          return { success: false, error: `Unknown auth method: ${message.method}` }
        }
        return this.authenticateAsDevUser(metadata)

      // Extended auth methods (need protocol update)
      default: {
        // Check for extended methods via type assertion
        const extendedMessage = message as any

        if (extendedMessage.method === "api_token") {
          return this.authenticateWithApiToken(extendedMessage.apiToken)
        }

        if (extendedMessage.method === "register") {
          return this.register(
            extendedMessage.email,
            extendedMessage.password,
            extendedMessage.displayName,
            metadata,
          )
        }

        if (extendedMessage.method === "google_init") {
          return this.initGoogleAuth()
        }

        if (extendedMessage.method === "microsoft_init") {
          return this.initMicrosoftAuth()
        }

        if (extendedMessage.method === "github_init") {
          return this.initGitHubAuth()
        }

        // Email verification: the 6-digit code sent after a password login/registration
        if (extendedMessage.method === "verify_email") {
          return this.completeEmailVerification(
            extendedMessage.challengeToken,
            extendedMessage.code,
          )
        }

        if (extendedMessage.method === "resend_email_verification") {
          return this.resendEmailVerification(extendedMessage.challengeToken)
        }

        // Password reset: request a code, submit code+new password, or resend
        if (extendedMessage.method === "forgot_password") {
          return this.requestPasswordReset(extendedMessage.email, metadata)
        }

        if (extendedMessage.method === "reset_password") {
          return this.completePasswordReset(
            extendedMessage.challengeToken,
            extendedMessage.code,
            extendedMessage.newPassword,
          )
        }

        if (extendedMessage.method === "verify_password_reset") {
          return this.verifyPasswordResetCode(extendedMessage.challengeToken, extendedMessage.code)
        }

        if (extendedMessage.method === "resend_password_reset") {
          return this.resendPasswordReset(extendedMessage.challengeToken)
        }

        // MFA challenge completion: verify TOTP code and create session
        if (extendedMessage.method === "mfa_challenge") {
          return this.completeMFAChallenge(
            extendedMessage.challengeToken,
            extendedMessage.mfaCode,
          )
        }

        return {
          success: false,
          error: `Unknown auth method: ${extendedMessage.method}`,
        }
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
      const auth = this.getAuth()
      const result = await auth.loginWithPassword({
        email,
        password,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      })

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          lockedUntil: result.lockedUntil,
          mfaChallenge: result.mfaChallenge,
          emailVerification: result.emailVerification,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Login error:", error)
      return {
        success: false,
        error: "Authentication failed",
      }
    }
  }

  /**
   * Dev auto-login: a normal session for the configured dev user, no
   * credentials. Only reached when the WS handler vouched for the connection.
   */
  private async authenticateAsDevUser(metadata: { userAgent?: string; ipAddress?: string }): Promise<AuthResult> {
    const state = getDevAutologin()
    if (!state.enabled) {
      return { success: false, error: "Unknown auth method: dev" }
    }
    try {
      const result = await this.getAuth().loginAsDevUser({
        email: state.userEmail,
        userAgent: metadata.userAgent,
        ipAddress: metadata.ipAddress,
      })
      if (!result.success || !result.user || !result.session) {
        return { success: false, error: result.error, errorCode: result.errorCode }
      }
      return {
        success: true,
        userId: result.user.userId as UserId,
        sessionToken: result.session.token,
        user: this.toClientUser(result.user),
      }
    } catch (error) {
      console.error("[AuthHandler] Dev auto-login error:", error)
      return { success: false, error: "Dev auto-login failed" }
    }
  }

  /**
   * Authenticate with session token
   */
  private async authenticateWithToken(token: string): Promise<AuthResult> {
    try {
      const auth = this.getAuth()
      const result = await auth.validateSession(token)

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: token,
        user: this.toClientUser(result.user!),
        sessionExpiresAt: result.session?.session?.expiresAt
          ? toIsoString(result.session.session.expiresAt)
          : undefined,
        impersonation: result.impersonationMeta,
      }
    } catch (error) {
      console.error("[AuthHandler] Token validation error:", error)
      return {
        success: false,
        error: "Invalid session token",
      }
    }
  }

  /**
   * Authenticate with API token (for external services like G2 glasses, CLI tools)
   * Looks up the token in api_tokens (API tokens) collection and returns the userId.
   * The WS handler creates the session after authenticate() succeeds.
   */
  private async authenticateWithApiToken(apiToken: string): Promise<AuthResult> {
    try {
      if (!this.db) {
        return { success: false, error: "API token auth not available (no DB)" }
      }

      // Unknown token, or its user is deleted/suspended → rejected
      const tokenDoc = await resolveApiToken(this.db, apiToken)
      if (!tokenDoc) {
        return { success: false, error: "Invalid API token" }
      }

      // Get user data
      const user = await this.db.collection("users").findOne({ userId: tokenDoc.userId })
      if (!user) {
        return { success: false, error: "User not found for API token" }
      }

      return {
        success: true,
        userId: tokenDoc.userId as UserId,
        sessionToken: apiToken, // reuse the API token as session token for WS lifecycle
        user: this.toClientUser(user as User),
      }
    } catch (error) {
      console.error("[AuthHandler] API token validation error:", error)
      return { success: false, error: "Invalid API token" }
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
      const auth = this.getAuth()
      const result = await auth.register({
        email,
        password,
        displayName,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      })

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          emailVerification: result.emailVerification,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Registration error:", error)
      return {
        success: false,
        error: "Registration failed",
      }
    }
  }

  /**
   * Complete a password login with the code emailed to the user.
   * May still answer with an MFA challenge when the user has MFA enabled.
   */
  private async completeEmailVerification(challengeToken: string, code: string): Promise<AuthResult> {
    try {
      if (typeof challengeToken !== "string" || typeof code !== "string") {
        return { success: false, error: "Missing verification code", errorCode: "email_verification_invalid" }
      }

      const auth = this.getAuth()
      const result = await auth.completeEmailVerification(challengeToken, code)

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          mfaChallenge: result.mfaChallenge,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Email verification error:", error)
      return {
        success: false,
        error: "Email verification failed",
      }
    }
  }

  /**
   * Email a fresh code for a pending verification challenge.
   */
  private async resendEmailVerification(challengeToken: string): Promise<AuthResult> {
    try {
      if (typeof challengeToken !== "string") {
        return { success: false, error: "Missing challenge", errorCode: "email_verification_invalid" }
      }

      const result = await this.getAuth().resendEmailVerification(challengeToken)
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        emailVerification: result.emailVerification,
      }
    } catch (error) {
      console.error("[AuthHandler] Resend email verification error:", error)
      return {
        success: false,
        error: "Could not send a new code",
      }
    }
  }

  /**
   * Start a password reset: send a 6-digit code to the email if it exists.
   * Always returns the same shape to avoid account enumeration.
   */
  private async requestPasswordReset(
    email: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    try {
      if (typeof email !== "string" || !email.includes("@")) {
        return { success: false, error: "Valid email required", errorCode: "password_reset_invalid" }
      }

      const result = await this.getAuth().requestPasswordReset(email, metadata)
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        passwordReset: result.passwordReset,
      }
    } catch (error) {
      console.error("[AuthHandler] Password reset request error:", error)
      return {
        success: false,
        error: "Could not process password reset request",
      }
    }
  }

  /**
   * Complete a password reset with the emailed code and a new password.
   */
  private async completePasswordReset(
    challengeToken: string,
    code: string,
    newPassword: string,
  ): Promise<AuthResult> {
    try {
      if (typeof challengeToken !== "string" || typeof code !== "string" || typeof newPassword !== "string") {
        return { success: false, error: "Missing reset code or password", errorCode: "password_reset_invalid" }
      }

      const result = await this.getAuth().completePasswordReset(challengeToken, code, newPassword)

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Password reset completion error:", error)
      return {
        success: false,
        error: "Password reset failed",
      }
    }
  }

  /**
   * Check the emailed code before the client asks for the new password.
   */
  private async verifyPasswordResetCode(challengeToken: string, code: string): Promise<AuthResult> {
    try {
      if (typeof challengeToken !== "string" || typeof code !== "string") {
        return { success: false, error: "Missing reset code", errorCode: "password_reset_invalid" }
      }

      const result = await this.getAuth().verifyPasswordResetCode(challengeToken, code)
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        passwordReset: result.passwordReset,
      }
    } catch (error) {
      console.error("[AuthHandler] Password reset code check error:", error)
      return {
        success: false,
        error: "Could not check the reset code",
      }
    }
  }

  /**
   * Resend the password reset code for a pending challenge.
   */
  private async resendPasswordReset(challengeToken: string): Promise<AuthResult> {
    try {
      if (typeof challengeToken !== "string") {
        return { success: false, error: "Missing challenge", errorCode: "password_reset_invalid" }
      }

      const result = await this.getAuth().resendPasswordReset(challengeToken)
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        passwordReset: result.passwordReset,
      }
    } catch (error) {
      console.error("[AuthHandler] Resend password reset error:", error)
      return {
        success: false,
        error: "Could not send a new code",
      }
    }
  }

  /**
   * Complete an MFA challenge during login.
   * The client sends the challenge token (from the mfa_required response)
   * and the TOTP code from the user's authenticator app.
   */
  private async completeMFAChallenge(
    challengeToken: string,
    mfaCode: string,
  ): Promise<AuthResult> {
    try {
      const auth = this.getAuth()
      const result = await auth.completeMFAChallenge(challengeToken, mfaCode)

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] MFA challenge error:", error)
      return {
        success: false,
        error: "MFA verification failed",
      }
    }
  }

  /**
   * Initialize Google OAuth flow
   * Returns URL for client to open in browser
   */
  async initGoogleOAuth(): Promise<AuthResult> {
    return this.initGoogleAuth()
  }

  /**
   * Initialize Google OAuth flow (internal)
   * Returns URL for client to open in browser
   */
  private async initGoogleAuth(): Promise<AuthResult> {
    const googleAuth = getGoogleAuth()

    if (!googleAuth) {
      return {
        success: false,
        error: "Google authentication not configured",
      }
    }

    try {
      const { url, state } = await googleAuth.generateAuthUrl()

      return {
        success: true,
        redirectUrl: url,
        url,
        state,
      }
    } catch (error) {
      console.error("[AuthHandler] Google auth init error:", error)
      return {
        success: false,
        error: "Failed to initialize Google authentication",
      }
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
    const googleAuth = getGoogleAuth()

    if (!googleAuth) {
      return {
        success: false,
        error: "Google authentication not configured",
      }
    }

    try {
      // Complete OAuth flow
      const oauthResult = await googleAuth.completeOAuthFlow(code, state)

      if (!oauthResult.success) {
        return {
          success: false,
          error: oauthResult.error,
        }
      }

      const { userInfo, tokens } = oauthResult

      // Login or create user via AuthService
      const auth = this.getAuth()
      const result = await auth.loginWithOAuth({
        provider: "google",
        providerUserId: userInfo!.id,
        email: userInfo!.email,
        emailVerified: userInfo!.verified_email === true,
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
        scopes: tokens!.scope?.split(" "),
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      })

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Google callback error:", error)
      captureException(error, { context: "auth-google-callback" })
      return {
        success: false,
        error: "Google authentication failed",
      }
    }
  }

  /**
   * Logout (revoke session)
   */
  async logout(token: string): Promise<boolean> {
    try {
      const auth = this.getAuth()
      return auth.logout(token)
    } catch (error) {
      console.error("[AuthHandler] Logout error:", error)
      return false
    }
  }

  /**
   * Initialize Microsoft OAuth flow
   * Returns URL for client to open in browser
   */
  async initMicrosoftOAuth(): Promise<AuthResult> {
    return this.initMicrosoftAuth()
  }

  /**
   * Initialize Microsoft OAuth flow (internal)
   * Returns URL for client to open in browser
   */
  private async initMicrosoftAuth(): Promise<AuthResult> {
    const microsoftAuth = getMicrosoftAuth()

    if (!microsoftAuth) {
      return {
        success: false,
        error: "Microsoft authentication not configured",
      }
    }

    try {
      const { url, state } = await microsoftAuth.generateAuthUrl()

      return {
        success: true,
        redirectUrl: url,
        url,
        state,
      }
    } catch (error) {
      console.error("[AuthHandler] Microsoft auth init error:", error)
      return {
        success: false,
        error: "Failed to initialize Microsoft authentication",
      }
    }
  }

  /**
   * Handle Microsoft OAuth callback (called from HTTP handler)
   * Returns auth result that can be used to create WebSocket session
   */
  async handleMicrosoftCallback(
    code: string,
    state: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const microsoftAuth = getMicrosoftAuth()

    if (!microsoftAuth) {
      return {
        success: false,
        error: "Microsoft authentication not configured",
      }
    }

    try {
      // Complete OAuth flow
      const oauthResult = await microsoftAuth.completeOAuthFlow(code, state)

      if (!oauthResult.success) {
        return {
          success: false,
          error: oauthResult.error,
        }
      }

      const { userInfo, tokens, avatarUrl } = oauthResult

      // Login or create user via AuthService
      const auth = this.getAuth()
      const result = await auth.loginWithOAuth({
        provider: "microsoft",
        providerUserId: userInfo!.id,
        email: userInfo!.email,
        // Graph's mail/userPrincipalName are set by the tenant admin, not proven
        emailVerified: false,
        displayName: userInfo!.displayName,
        avatarUrl: avatarUrl,
        accessToken: tokens!.access_token,
        refreshToken: tokens!.refresh_token,
        tokenExpiresAt: tokens!.expires_in
          ? new Date(Date.now() + tokens!.expires_in * 1000)
          : undefined,
        providerProfile: {
          name: userInfo!.displayName,
          email: userInfo!.email,
          avatarUrl,
          raw: userInfo,
        },
        scopes: tokens!.scope?.split(" "),
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      })

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] Microsoft callback error:", error)
      captureException(error, { context: "auth-microsoft-callback" })
      return {
        success: false,
        error: "Microsoft authentication failed",
      }
    }
  }

  /**
   * Initialize GitHub OAuth flow
   * Returns URL for client to open in browser
   */
  async initGitHubOAuth(): Promise<AuthResult> {
    return this.initGitHubAuth()
  }

  /**
   * Initialize GitHub OAuth flow (internal)
   * Returns URL for client to open in browser
   */
  private async initGitHubAuth(): Promise<AuthResult> {
    const githubAuth = getGitHubAuth()

    if (!githubAuth) {
      return {
        success: false,
        error: "GitHub authentication not configured",
      }
    }

    try {
      const { url, state } = await githubAuth.generateAuthUrl()

      return {
        success: true,
        redirectUrl: url,
        url,
        state,
      }
    } catch (error) {
      console.error("[AuthHandler] GitHub auth init error:", error)
      return {
        success: false,
        error: "Failed to initialize GitHub authentication",
      }
    }
  }

  /**
   * Handle GitHub OAuth callback (called from HTTP handler)
   * Returns auth result that can be used to create WebSocket session
   */
  async handleGitHubCallback(
    code: string,
    state: string,
    metadata?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const githubAuth = getGitHubAuth()

    if (!githubAuth) {
      return {
        success: false,
        error: "GitHub authentication not configured",
      }
    }

    try {
      // Complete OAuth flow
      const oauthResult = await githubAuth.completeOAuthFlow(code, state)

      if (!oauthResult.success) {
        return {
          success: false,
          error: oauthResult.error,
        }
      }

      const { userInfo, tokens } = oauthResult

      // Login or create user via AuthService
      // displayName: GitHub name may be null → fallback to login (username)
      const displayName = userInfo!.name || userInfo!.login

      const auth = this.getAuth()
      const result = await auth.loginWithOAuth({
        provider: "github",
        providerUserId: String(userInfo!.id),
        email: userInfo!.email,
        emailVerified: userInfo!.email_verified,
        displayName,
        avatarUrl: userInfo!.avatar_url,
        accessToken: tokens!.access_token,
        refreshToken: undefined, // GitHub OAuth tokens don't expire by default
        tokenExpiresAt: undefined,
        providerProfile: {
          name: displayName,
          email: userInfo!.email,
          avatarUrl: userInfo!.avatar_url,
          raw: userInfo,
        },
        scopes: tokens!.scope?.split(" "),
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      })

      if (!result.success) {
        return {
          success: false,
          error: result.error,
          errorCode: result.errorCode,
        }
      }

      return {
        success: true,
        userId: result.user!.userId as UserId,
        sessionToken: result.session!.token,
        user: this.toClientUser(result.user!),
      }
    } catch (error) {
      console.error("[AuthHandler] GitHub callback error:", error)
      captureException(error, { context: "auth-github-callback" })
      return {
        success: false,
        error: "GitHub authentication failed",
      }
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
      role: user.role || "user",
      emailVerified: user.emailVerified,
      termsAcceptedAt: toIsoString(user.termsAcceptedAt),
      onboardingCompletedAt: toIsoString(user.onboardingCompletedAt),
      accessGranted: user.accessGranted,
      edition: TEROS_EDITION,
    }
  }
}
