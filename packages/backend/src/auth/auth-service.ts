/**
 * Auth Service
 *
 * Main authentication orchestrator.
 * Coordinates UserService, IdentityService, and SessionService
 * to handle registration, login, and session management.
 */

import type { Db, ObjectId } from 'mongodb';
import { randomBytes } from 'crypto';
import type { AgentProvisioningService } from '../services/agent-provisioning-service';
import type { FeatureFlagService } from '../services/feature-flag-service';
import type { ProviderService } from '../services/provider-service';
import type { WorkspaceService } from '../services/workspace-service';
import { auditLogger } from '../lib/audit-logger';
import { revokeUserApiTokens } from './api-tokens';
import { DefaultAgentService } from './default-agent-service';
import {
  EmailVerificationService,
  type EmailVerificationPurpose,
} from './email-verification-service';
import { IdentityService } from './identity-service';
import { MFAService, type MFASetupResult, type MFAVerifyResult } from './mfa-service';
import { PasswordResetService } from './password-reset-service';
import { sendWelcomeEmail } from './registration-email';
import { SessionService, type SessionWithToken, hashSessionToken } from './session-service';
import type { IdentityProvider, OAuthIdentityData, User, UserIdentity, UserSession } from './types';
import { UserService } from './user-service';

export interface ImpersonationMeta {
  isImpersonating: true;
  impersonatedBy: string;
  impersonatedByName: string;
}

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
    | 'session_expired'
    | 'mfa_required'
    | 'mfa_invalid'
    | 'email_verification_required'
    | 'email_verification_invalid'
    | 'email_verification_resend_limited'
    | 'password_reset_required'
    | 'password_reset_code_valid'
    | 'password_reset_invalid'
    | 'password_reset_resend_limited'
    | 'password_too_weak';
  lockedUntil?: Date;
  /** Present when the session is an impersonation session */
  impersonationMeta?: ImpersonationMeta;
  /**
   * Present when MFA is required to complete login.
   * The client must prompt for a TOTP code and call completeMFAChallenge().
   */
  mfaChallenge?: {
    userId: string;
    /** A short-lived token the client sends back with the TOTP code */
    challengeToken: string;
  };
  /**
   * Present when the email must be verified before a session is issued.
   * The client prompts for the emailed 6-digit code and calls
   * completeEmailVerification().
   */
  emailVerification?: {
    /** A short-lived token the client sends back with the code */
    challengeToken: string;
    email: string;
  };
  /**
   * Present when a password reset is waiting for the emailed code.
   * The client prompts for the code + a new password and calls
   * completePasswordReset().
   */
  passwordReset?: {
    /** A short-lived token the client sends back with the code */
    challengeToken: string;
    email: string;
    /** True in the answer to verifyPasswordResetCode when the code is right */
    codeVerified?: boolean;
  };
}

const EMAIL_VERIFICATION_ERRORS = {
  challenge_invalid: 'Verification code expired. Sign in again to get a new one.',
  code_invalid: 'Incorrect verification code',
  too_many_attempts: 'Too many incorrect codes. Sign in again to get a new one.',
  resend_too_soon: 'Wait a minute before asking for a new code',
  too_many_sends: 'Too many codes requested. Sign in again later.',
} as const;

const PASSWORD_RESET_ERRORS = {
  challenge_invalid: 'Reset code expired. Start over to get a new one.',
  code_invalid: 'Incorrect reset code',
  too_many_attempts: 'Too many incorrect codes. Start over to get a new one.',
  resend_too_soon: 'Wait a minute before asking for a new code',
  too_many_sends: 'Too many codes requested. Try again later.',
} as const;

interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
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
  /**
   * Whether the provider vouches that this user owns `email`. Only a vouched
   * email can claim an existing account; Microsoft never vouches (mail/UPN
   * are set by the tenant admin).
   */
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
  /** Provider tokens: accepted from the OAuth callback but never stored (SEC-4) */
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
  private mfaService: MFAService;
  private emailVerificationService: EmailVerificationService;
  private passwordResetService: PasswordResetService;

  /**
   * In-memory store of pending MFA challenge tokens.
   * Maps challengeToken → { userId, identityId, expiresAt, userAgent?, ipAddress? }
   * Short-lived (5 minutes). Cleared on successful completion or expiry.
   */
  private mfaChallenges = new Map<string, {
    userId: string;
    identityId: ObjectId;
    expiresAt: Date;
    userAgent?: string;
    ipAddress?: string;
  }>();

  constructor(private db: Db) {
    this.userService = new UserService(db);
    this.identityService = new IdentityService(db);
    this.sessionService = new SessionService(db);
    this.defaultAgentService = new DefaultAgentService(db);
    this.mfaService = new MFAService(db);
    this.emailVerificationService = new EmailVerificationService(db);
    this.passwordResetService = new PasswordResetService(db);
  }

  /**
   * Late-bind the WorkspaceService after the DI container is ready.
   * Called from index.ts after the container is initialized to avoid
   * circular dependency issues at startup.
   */
  setWorkspaceService(workspaceService: WorkspaceService): void {
    this.userService.setWorkspaceService(workspaceService);
    console.log('[AuthService] WorkspaceService connected to UserService');
  }

  /**
   * Late-bind the AgentProvisioningService (depends on McaService, built after
   * AuthService). Required for default-agent creation during onboarding.
   */
  setProvisioningService(provisioningService: AgentProvisioningService): void {
    this.defaultAgentService.setProvisioningService(provisioningService);
    console.log('[AuthService] AgentProvisioningService connected to DefaultAgentService');
  }

  /**
   * Sign-in provisioning (SIP): make sure the user has their Private workspace
   * and a default agent. Idempotent, so registration-created users are a no-op;
   * users created by scripts (installer admin) or migrations get both here.
   * Never blocks the sign-in: each step is logged and swallowed on failure.
   *
   * @spec SIP-REQ-2 SIP-REQ-3 SIP-REQ-4
   */
  private async ensureSignInDefaults(userId: string): Promise<void> {
    try {
      await this.userService.ensurePrivateWorkspace(userId);
    } catch (err) {
      console.error(`[AuthService] Private workspace provisioning failed for ${userId}:`, err);
    }
    try {
      await this.defaultAgentService.createDefaultAgentIfNeeded(userId);
    } catch (err) {
      console.error(`[AuthService] Default agent provisioning failed for ${userId}:`, err);
    }
  }

  /**
   * Late-bind the FeatureFlagService (depends on the DB and is registered after
   * AuthService). Required so UserService can read access.auto-grant at user
   * creation time without a circular dependency at construction.
   */
  setFeatureFlagService(featureFlagService: FeatureFlagService): void {
    this.userService.setFeatureFlagService(featureFlagService);
    console.log('[AuthService] FeatureFlagService connected to UserService');
  }

  /**
   * Late-bind the ProviderService (depends on the DB and is registered after
   * AuthService). Required so UserService can provision the default Teros
   * provider at user creation time without a circular dependency at construction.
   */
  setProviderService(providerService: ProviderService): void {
    this.userService.setProviderService(providerService);
    console.log('[AuthService] ProviderService connected to UserService');
  }

  /**
   * Initialize all auth-related indexes
   */
  async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.userService.ensureIndexes(),
      this.identityService.ensureIndexes(),
      this.sessionService.ensureIndexes(),
      this.emailVerificationService.ensureIndexes(),
      this.passwordResetService.ensureIndexes(),
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

    // Also check identities (in case of partial registration)
    const existingIdentity = await this.identityService.getByProvider('password', email);
    if (existingIdentity) {
      return {
        success: false,
        error: 'Email already registered',
        errorCode: 'email_exists',
      };
    }

    // Check if email already exists. A user with no identity at all is a
    // registration that died between creating the user and its identity
    // (MOD-5): reuse it instead of leaving the address taken with no way in.
    // Safe to hand over: the session still needs the emailed code.
    let user: User;
    const existingUser = await this.userService.getByEmail(email);
    if (existingUser) {
      const orphan = !existingUser.emailVerified && !(await this.identityService.hasAnyIdentity(existingUser.userId));
      if (!orphan) {
        return {
          success: false,
          error: 'Email already registered',
          errorCode: 'email_exists',
        };
      }
      user = existingUser;
    } else {
      // Create user
      user = await this.userService.createUser({
        email,
        displayName: params.displayName,
        emailVerified: false,
      });
    }

    // Create password identity
    const identity = await this.identityService.createPasswordIdentity({
      userId: user.userId,
      email,
      password: params.password,
    });

    // Create default agent if user has none
    // Provisioning the default agent must never block the sign-in itself: a
    // missing agent core or a provisioning hiccup on an environment leaves
    // the user without an agent, not without an account. Log and go on.
    try {
      await this.defaultAgentService.createDefaultAgentIfNeeded(user.userId);
    } catch (err) {
      console.error(`[AuthService] Default agent provisioning failed for ${user.userId}:`, err);
    }

    // Audit log: successful registration (Req 6.5.1)
    await auditLogger.log({
      event: 'register.success',
      actorUserId: user.userId,
      ip: params.ipAddress,
      userAgent: params.userAgent,
      detail: { email: user.profile.email, method: 'password' },
    });

    // No session until the emailed code comes back; the welcome email is sent
    // by completeEmailVerification() once the address is proven.
    return this.startEmailVerification(user, identity._id, 'register', params);
  }

  // ============================================================================
  // PASSWORD LOGIN
  // ============================================================================

  /**
   * Login with email/password
   *
   * If the user has MFA enabled, returns a partial success with an MFA challenge.
   * The client must then call completeMFAChallenge() with the TOTP code.
   */
  async loginWithPassword(params: LoginParams): Promise<AuthResult> {
    const email = params.email.toLowerCase();

    // Verify password
    const verifyResult = await this.identityService.verifyPassword(email, params.password);

    if (!verifyResult.success) {
      // Audit log: failed login attempt (Req 6.5.1)
      await auditLogger.log({
        event: 'login.failure',
        ip: params.ipAddress,
        userAgent: params.userAgent,
        detail: {
          method: 'password',
          email,
          reason: verifyResult.error,
          lockedUntil: verifyResult.lockedUntil?.toISOString(),
        },
      });

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

    // Password accounts must prove they own their email before getting a session
    if (!user.emailVerified) {
      return this.startEmailVerification(user, identity._id, 'login', params);
    }

    // Check if MFA is enabled — if so, issue an MFA challenge instead of creating a session
    if (user.mfa?.enabled) {
      return this.issueMFAChallenge(user, identity._id, params);
    }

    // No MFA — create session directly
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);
    await this.ensureSignInDefaults(user.userId);

    // Audit log: successful password login (Req 6.5.1)
    await auditLogger.log({
      event: 'login.success',
      actorUserId: user.userId,
      ip: params.ipAddress,
      userAgent: params.userAgent,
      detail: { method: 'password' },
    });

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Dev auto-login (LOCAL ONLY): mint a normal session for the dev user with
   * no credentials. Callers MUST have checked isDevAutologinRequestAllowed —
   * this method trusts that the connection is a local dev one.
   */
  async loginAsDevUser(params: {
    email: string;
    userAgent?: string;
    ipAddress?: string;
  }): Promise<AuthResult> {
    const user = await this.findUserByEmail(params.email.toLowerCase());
    if (!user) {
      return {
        success: false,
        error: `Dev auto-login: no user ${params.email} (create it, or fix TEROS_DEV_USER)`,
        errorCode: 'identity_not_found',
      };
    }
    if (user.status === 'suspended') {
      return { success: false, error: 'Account suspended', errorCode: 'account_suspended' };
    }

    const [identity] = await this.identityService.getByUserId(user.userId);
    if (!identity) {
      return {
        success: false,
        error: `Dev auto-login: ${user.profile.email} has no active identity`,
        errorCode: 'identity_not_found',
      };
    }

    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: identity._id,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });
    await this.userService.updateLastLogin(user.userId);
    // The installer's admin never signs in with a password: its Private workspace
    // and default agent are created here, as for any other sign-in (ALOGIN-REQ-8)
    await this.ensureSignInDefaults(user.userId);
    await auditLogger.log({
      event: 'login.success',
      actorUserId: user.userId,
      ip: params.ipAddress,
      userAgent: params.userAgent,
      detail: { method: 'dev' },
    });

    return { success: true, user, session };
  }

  /**
   * Issue an MFA challenge instead of a session.
   * The client must then call completeMFAChallenge() with the TOTP code.
   */
  private async issueMFAChallenge(
    user: User,
    identityId: ObjectId,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const challengeToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    this.mfaChallenges.set(challengeToken, {
      userId: user.userId,
      identityId,
      expiresAt,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    // Clean up expired challenges (fire and forget)
    this.cleanupExpiredMFAChallenges();

    // Audit log: MFA challenge issued (Req 6.5.1)
    await auditLogger.log({
      event: 'login.mfa_required',
      actorUserId: user.userId,
      ip: meta.ipAddress,
      userAgent: meta.userAgent,
      detail: { method: 'password', email: user.profile.email },
    });

    return {
      success: false,
      error: 'MFA verification required',
      errorCode: 'mfa_required',
      mfaChallenge: {
        userId: user.userId,
        challengeToken,
      },
    };
  }

  // ============================================================================
  // EMAIL VERIFICATION
  // ============================================================================

  /**
   * Email a 6-digit code to the user and return a challenge instead of a session.
   */
  private async startEmailVerification(
    user: User,
    identityId: ObjectId,
    purpose: EmailVerificationPurpose,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const email = user.profile.email;
    const { challengeToken, code } = await this.emailVerificationService.issue({
      userId: user.userId,
      identityId,
      email,
      purpose,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    void this.sendVerificationCode(email, user.profile.displayName, code);

    await auditLogger.log({
      event: 'login.email_verification_required',
      actorUserId: user.userId,
      ip: meta.ipAddress,
      userAgent: meta.userAgent,
      detail: { purpose },
    });

    return {
      success: false,
      error: 'Email verification required',
      errorCode: 'email_verification_required',
      emailVerification: { challengeToken, email },
    };
  }

  /**
   * Finish a password login (or registration) with the emailed code.
   * Marks the email as verified, then continues with MFA or a session.
   */
  async completeEmailVerification(challengeToken: string, code: string): Promise<AuthResult> {
    const result = await this.emailVerificationService.verify(challengeToken, code);
    if (!result.success) {
      await auditLogger.log({
        event: 'login.email_verification_failure',
        detail: { reason: result.error },
      });
      return {
        success: false,
        error: EMAIL_VERIFICATION_ERRORS[result.error],
        errorCode: 'email_verification_invalid',
      };
    }

    const { challenge } = result;
    const meta = { userAgent: challenge.userAgent, ipAddress: challenge.ipAddress };
    await this.userService.markEmailVerified(challenge.userId);
    // MUW-14 Fase 2: no auto-activation on email verification — the invitation
    // stays pending and the user accepts/declines it in the app.

    const user = await this.userService.getByUserId(challenge.userId);
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

    await auditLogger.log({
      event: 'login.email_verified',
      actorUserId: user.userId,
      ip: meta.ipAddress,
      userAgent: meta.userAgent,
      detail: { purpose: challenge.purpose },
    });

    if (challenge.purpose === 'register') {
      // Send welcome email (fire-and-forget)
      void this.sendRegistrationEmail(user);
    }

    if (user.mfa?.enabled) {
      return this.issueMFAChallenge(user, challenge.identityId, meta);
    }

    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: challenge.identityId,
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);
    await this.ensureSignInDefaults(user.userId);

    await auditLogger.log({
      event: 'login.success',
      actorUserId: user.userId,
      ip: meta.ipAddress,
      userAgent: meta.userAgent,
      detail: { method: 'password+email_code' },
    });

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Email a fresh code for a pending verification challenge.
   */
  async resendEmailVerification(challengeToken: string): Promise<AuthResult> {
    const result = await this.emailVerificationService.resend(challengeToken);
    if (!result.success) {
      return {
        success: false,
        error: EMAIL_VERIFICATION_ERRORS[result.error],
        errorCode:
          result.error === 'challenge_invalid'
            ? 'email_verification_invalid'
            : 'email_verification_resend_limited',
      };
    }

    const user = await this.userService.getByUserId(result.challenge.userId);
    void this.sendVerificationCode(
      result.challenge.email,
      user?.profile.displayName || result.challenge.email.split('@')[0],
      result.code,
    );

    return {
      success: false,
      error: 'Verification code sent',
      errorCode: 'email_verification_required',
      emailVerification: { challengeToken, email: result.challenge.email },
    };
  }

  /**
   * Send the verification email (fire-and-forget). Without email configured
   * (local dev) the code is printed to the log so sign-in still works.
   */
  private async sendVerificationCode(email: string, displayName: string, code: string): Promise<void> {
    try {
      const { isEmailConfigured, getEmailService } = await import('../services/email-service');
      if (!isEmailConfigured()) {
        if (process.env.NODE_ENV === 'production') {
          console.error(`[AuthService] Email is not configured: cannot send the verification code to ${email}`);
        } else {
          console.warn(`[AuthService] Email is not configured. Verification code for ${email}: ${code}`);
        }
        return;
      }

      const result = await getEmailService().sendEmailVerification(email, {
        USER_NAME: displayName,
        CODE: code,
      });
      if (!result.success) {
        console.error(`[AuthService] Failed to send verification code to ${email}: ${result.error}`);
      }
    } catch (e) {
      console.error('[AuthService] Failed to send verification code:', e);
    }
  }

  // ============================================================================
  // PASSWORD RESET
  // ============================================================================

  /**
   * Start a password reset for an email address.
   *
   * Security: always returns the same shape whether the email exists or not,
   * so callers can't enumerate accounts. If the email is unknown, a decoy
   * challenge is issued (same timing, same response shape) that will always
   * fail verification.
   */
  async requestPasswordReset(
    email: string,
    meta?: { userAgent?: string; ipAddress?: string },
  ): Promise<AuthResult> {
    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit: max 3 codes per hour per email
    const limited = await this.passwordResetService.isSendLimited(normalizedEmail);
    if (limited) {
      await auditLogger.log({
        event: 'password_reset.request_limited',
        ip: meta?.ipAddress,
        userAgent: meta?.userAgent,
        detail: { email: normalizedEmail },
      });
      // Same shape as success to avoid leaking which emails are limited.
      // The literal 'limited' token is not a real challenge: verify() will
      // reject it as challenge_invalid, which is the correct outcome — a
      // rate-limited caller must not be able to complete a reset.
      return {
        success: false,
        error: 'If the email is registered, a reset code has been sent',
        errorCode: 'password_reset_required',
        passwordReset: { challengeToken: 'limited', email: normalizedEmail },
      };
    }

    // Find the password identity for this email
    let identity = await this.identityService.getByProvider('password', normalizedEmail);
    let user = identity ? await this.userService.getByUserId(identity.userId) : null;

    // An account that signs in only through an OAuth provider has no password
    // identity, so this lookup misses and the request dead-ends in the decoy: the
    // user is told a code was sent and none is. Give the account a password
    // identity nobody can sign in with (see provisionUnusablePasswordIdentity)
    // so the reset can proceed and the user can choose their first password.
    // Proving control of the mailbox by entering the emailed code is the check
    // that authorises this; a suspended account stays in the decoy below so a
    // ban cannot be lifted through self-service.
    if (!identity) {
      const owner = await this.findUserByEmail(normalizedEmail);
      if (owner && owner.status !== 'suspended') {
        identity = await this.identityService.provisionUnusablePasswordIdentity(
          owner.userId,
          normalizedEmail,
        );
        user = owner;
        await auditLogger.log({
          event: 'password_reset.provisioned_identity',
          actorUserId: owner.userId,
          ip: meta?.ipAddress,
          userAgent: meta?.userAgent,
          detail: { email: normalizedEmail },
        });
      }
    }

    if (!identity || !user) {
      // Decoy challenge: same shape, same timing, but will never verify
      const { challengeToken } = await this.passwordResetService.issue({
        userId: 'unknown',
        identityId: new (await import('mongodb')).ObjectId(),
        email: normalizedEmail,
        userAgent: meta?.userAgent,
        ipAddress: meta?.ipAddress,
      });
      await auditLogger.log({
        event: 'password_reset.request_decoy',
        ip: meta?.ipAddress,
        userAgent: meta?.userAgent,
        detail: { email: normalizedEmail },
      });
      return {
        success: false,
        error: 'If the email is registered, a reset code has been sent',
        errorCode: 'password_reset_required',
        passwordReset: { challengeToken, email: normalizedEmail },
      };
    }

    // Real challenge
    const { challengeToken, code } = await this.passwordResetService.issue({
      userId: user.userId,
      identityId: identity._id,
      email: normalizedEmail,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
    });

    // Store the hashed reset token on the identity (as designed in types.ts)
    const tokenHash = (await import('crypto')).createHash('sha256').update(challengeToken).digest('hex');
    await this.identityService.setPasswordResetToken(identity._id, tokenHash, new Date(Date.now() + 15 * 60 * 1000));

    void this.sendPasswordResetCode(normalizedEmail, user.profile.displayName || normalizedEmail.split('@')[0], code);

    await auditLogger.log({
      event: 'password_reset.requested',
      actorUserId: user.userId,
      ip: meta?.ipAddress,
      userAgent: meta?.userAgent,
      detail: { email: normalizedEmail },
    });

    return {
      success: false,
      error: 'If the email is registered, a reset code has been sent',
      errorCode: 'password_reset_required',
      passwordReset: { challengeToken, email: normalizedEmail },
    };
  }

  /**
   * Check the emailed code without consuming the challenge, so the client can
   * confirm it before asking for the new password. Wrong codes count against
   * the same attempt limit as completePasswordReset().
   */
  async verifyPasswordResetCode(challengeToken: string, code: string): Promise<AuthResult> {
    let result = await this.passwordResetService.check(challengeToken, code);

    // A decoy challenge (unknown email) never verifies, whatever the code:
    // count it as a wrong code so it behaves like a real challenge.
    if (result.success && result.challenge.userId === 'unknown') {
      result = await this.passwordResetService.check(challengeToken, '');
    }

    if (!result.success) {
      await auditLogger.log({
        event: 'password_reset.verify_failed',
        detail: { reason: result.error, step: 'check' },
      });
      const error =
        result.error === 'code_invalid'
          ? `Incorrect code. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'attempt' : 'attempts'} left.`
          : result.error === 'too_many_attempts'
            ? 'Too many incorrect codes. Request a new one.'
            : 'Reset code expired. Request a new one.';
      return { success: false, error, errorCode: 'password_reset_invalid' };
    }

    return {
      success: false,
      error: 'Code verified',
      errorCode: 'password_reset_code_valid',
      passwordReset: {
        challengeToken,
        email: result.challenge.email,
        codeVerified: true,
      },
    };
  }

  /**
   * Complete a password reset with the emailed code and a new password.
   * On success: updates the password, clears reset state, revokes all sessions,
   * and logs the user in with a fresh session.
   */
  async completePasswordReset(
    challengeToken: string,
    code: string,
    newPassword: string,
  ): Promise<AuthResult> {
    // Validate password strength (same rule as registration: min 8 chars)
    if (!newPassword || newPassword.length < 8) {
      return {
        success: false,
        error: 'Password must be at least 8 characters',
        errorCode: 'password_too_weak',
      };
    }

    const result = await this.passwordResetService.verify(challengeToken, code);
    if (!result.success) {
      await auditLogger.log({
        event: 'password_reset.verify_failed',
        detail: { reason: result.error },
      });
      const errors = {
        challenge_invalid: 'Reset code expired. Request a new one.',
        code_invalid: 'Incorrect reset code',
        too_many_attempts: 'Too many incorrect codes. Request a new one.',
      };
      return {
        success: false,
        error: errors[result.error],
        errorCode: 'password_reset_invalid',
      };
    }

    const { challenge } = result;

    // Decoy challenges have userId 'unknown' — always reject
    if (challenge.userId === 'unknown') {
      await auditLogger.log({
        event: 'password_reset.decoy_consumed',
        ip: challenge.ipAddress,
        userAgent: challenge.userAgent,
      });
      return {
        success: false,
        error: 'Reset code expired. Request a new one.',
        errorCode: 'password_reset_invalid',
      };
    }

    const user = await this.userService.getByUserId(challenge.userId);
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

    // Update password and clear reset/lockout state
    const passwordChanged = await this.identityService.changePassword(user.userId, newPassword);
    if (!passwordChanged) {
      return {
        success: false,
        error: 'Could not update password',
        errorCode: 'password_reset_invalid',
      };
    }

    // Clear the reset token from the identity
    await this.identityService.clearPasswordResetToken(challenge.identityId);

    // Revoke all existing sessions (security: whoever had the old password loses access)
    const sessionsRevoked = await this.sessionService.revokeAllUserSessions(user.userId, 'security');

    // Revoke API tokens too (they are bearer credentials)
    const apiTokensRevoked = await revokeUserApiTokens(this.db, user.userId);

    await auditLogger.log({
      event: 'password_reset.completed',
      actorUserId: user.userId,
      ip: challenge.ipAddress,
      userAgent: challenge.userAgent,
      detail: { sessionsRevoked, apiTokensRevoked },
    });

    // Create a fresh session for the user
    const session = await this.sessionService.createSession({
      userId: user.userId,
      identityId: challenge.identityId,
      userAgent: challenge.userAgent,
      ipAddress: challenge.ipAddress,
    });

    await this.userService.updateLastLogin(user.userId);
    await this.ensureSignInDefaults(user.userId);

    await auditLogger.log({
      event: 'login.success',
      actorUserId: user.userId,
      ip: challenge.ipAddress,
      userAgent: challenge.userAgent,
      detail: { method: 'password_reset' },
    });

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Resend the password reset code for a pending challenge.
   */
  async resendPasswordReset(challengeToken: string): Promise<AuthResult> {
    const result = await this.passwordResetService.resend(challengeToken);
    if (!result.success) {
      const errors = {
        challenge_invalid: 'Reset code expired. Request a new one.',
        resend_too_soon: 'Wait a minute before asking for a new code',
        too_many_sends: 'Too many codes requested. Try again later.',
      };
      return {
        success: false,
        error: errors[result.error],
        errorCode: result.error === 'challenge_invalid' ? 'password_reset_invalid' : 'password_reset_resend_limited',
      };
    }

    // Decoy challenges (unknown email) get a fresh code but no email is sent —
    // the response stays identical to the real case (anti-enumeration).
    if (result.challenge.userId !== 'unknown') {
      const user = await this.userService.getByUserId(result.challenge.userId);
      void this.sendPasswordResetCode(
        result.challenge.email,
        user?.profile.displayName || result.challenge.email.split('@')[0],
        result.code,
      );
    }

    return {
      success: false,
      error: 'If the email is registered, a reset code has been sent',
      errorCode: 'password_reset_required',
      passwordReset: { challengeToken, email: result.challenge.email },
    };
  }

  /**
   * Send the password reset email (fire-and-forget). Without email configured
   * (local dev) the code is printed to the log so the flow still works.
   */
  private async sendPasswordResetCode(email: string, displayName: string, code: string): Promise<void> {
    try {
      const { isEmailConfigured, getEmailService } = await import('../services/email-service');
      if (!isEmailConfigured()) {
        if (process.env.NODE_ENV === 'production') {
          console.error(`[AuthService] Email is not configured: cannot send the password reset code to ${email}`);
        } else {
          console.warn(`[AuthService] Email is not configured. Password reset code for ${email}: ${code}`);
        }
        return;
      }

      const result = await getEmailService().sendPasswordReset(email, {
        USER_NAME: displayName,
        CODE: code,
      });
      if (!result.success) {
        console.error(`[AuthService] Failed to send password reset code to ${email}: ${result.error}`);
      }
    } catch (e) {
      console.error('[AuthService] Failed to send password reset code:', e);
    }
  }

  // ============================================================================
  // OAUTH LOGIN
  // ============================================================================

  /**
   * Login or register with OAuth provider (Google, GitHub, etc.)
   *
   * Flow:
   * 1. Check if identity exists → login (unless revoked)
   * 2. Check if the email belongs to an existing user → link identity, but
   *    only when the provider vouches for the email (see linkByEmail)
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
      if (existingIdentity.status !== 'active') {
        return {
          success: false,
          error: 'This sign-in method has been disabled for your account',
          errorCode: 'identity_revoked',
        };
      }
      // Identity exists → update and login
      return this.loginExistingOAuthIdentity(existingIdentity, params);
    }

    const owner = await this.findUserByEmail(email);
    if (owner) {
      return this.linkByEmail(owner, params);
    }

    // New user → create user + identity
    return this.createOAuthUser(params);
  }

  /**
   * The user that already holds an email, by profile or by any active identity.
   */
  private async findUserByEmail(email: string): Promise<User | null> {
    const byProfile = await this.userService.getByEmail(email);
    if (byProfile) return byProfile;

    const identityWithEmail = await this.identityService.getAnyByEmail(email);
    return identityWithEmail ? this.userService.getByUserId(identityWithEmail.userId) : null;
  }

  /**
   * Link a new OAuth identity to the account that already holds its email.
   *
   * Linking by email hands the account to whoever controls that address, so:
   * - the provider must vouch for the email, or we refuse;
   * - if the account itself never proved the address (an unverified password
   *   signup, or a provider that doesn't vouch), the provider just did. The
   *   unproven credentials and their sessions are revoked first, so whoever
   *   registered the address without owning it (account pre-hijacking) loses
   *   access instead of sharing the account with its real owner.
   */
  private async linkByEmail(owner: User, params: OAuthLoginParams): Promise<AuthResult> {
    if (!params.emailVerified) {
      await auditLogger.log({
        event: 'login.failure',
        ip: params.ipAddress,
        userAgent: params.userAgent,
        detail: { method: 'oauth', provider: params.provider, reason: 'email_not_verified_by_provider' },
      });
      return {
        success: false,
        error: 'An account with this email already exists. Sign in with the method you used before.',
        errorCode: 'email_exists',
      };
    }

    if (!owner.emailVerified) {
      const identities = await this.identityService.getByUserId(owner.userId);
      for (const identity of identities) {
        await this.identityService.revokeIdentity(identity._id);
      }
      const sessions = await this.sessionService.revokeAllUserSessions(owner.userId, 'security');
      await this.userService.markEmailVerified(owner.userId);
      // MUW-14 Fase 2: no auto-activation on email verification — the
      // invitation stays pending and the user accepts/declines it in the app.

      await auditLogger.log({
        event: 'login.unverified_access_revoked',
        actorUserId: owner.userId,
        ip: params.ipAddress,
        userAgent: params.userAgent,
        detail: {
          provider: params.provider,
          revokedIdentities: identities.map((i) => i.type),
          revokedSessions: sessions,
        },
      });
    }

    return this.linkOAuthIdentity(owner.userId, params);
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
    await this.ensureSignInDefaults(user.userId);
    if (params.avatarUrl && !user.profile.avatarUrl) {
      await this.userService.updateProfile(user.userId, { avatarUrl: params.avatarUrl });
    }

    // Audit log: successful OAuth login (Req 6.5.1)
    await auditLogger.log({
      event: 'login.success',
      actorUserId: user.userId,
      ip: params.ipAddress,
      userAgent: params.userAgent,
      detail: { method: 'oauth', provider: params.provider },
    });

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
    await this.ensureSignInDefaults(user.userId);

    console.log(`[AuthService] Linked ${params.provider} identity to existing user ${userId}`);

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Send the appropriate welcome email for a newly-registered user
   * (fire-and-forget). "welcome" when the user has instant access,
   * "welcome-registered" for the legacy waitlist flow.
   */
  private async sendRegistrationEmail(user: User): Promise<void> {
    try {
      // email-service is imported dynamically (Resend + secrets are heavy and
      // would otherwise load on the registration request path). The routing
      // itself lives in the statically-imported pure helper.
      const { isEmailConfigured, getEmailService } = await import('../services/email-service');
      if (!isEmailConfigured()) return;

      await sendWelcomeEmail(getEmailService(), user);
    } catch (e) {
      console.error('[AuthService] Failed to send registration email:', e);
    }
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
      emailVerified: params.emailVerified,
    });

    // Create OAuth identity
    const identity = await this.identityService.upsertOAuthIdentity({
      userId: user.userId,
      type: params.provider,
      providerUserId: params.providerUserId,
      email: params.email,
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
    // Provisioning the default agent must never block the sign-in itself: a
    // missing agent core or a provisioning hiccup on an environment leaves
    // the user without an agent, not without an account. Log and go on.
    try {
      await this.defaultAgentService.createDefaultAgentIfNeeded(user.userId);
    } catch (err) {
      console.error(`[AuthService] Default agent provisioning failed for ${user.userId}:`, err);
    }

    // Send welcome email (fire-and-forget)
    void this.sendRegistrationEmail(user);

    console.log(`[AuthService] Created new user ${user.userId} with ${params.provider} identity`);

    // Audit log: successful registration via OAuth (Req 6.5.1)
    await auditLogger.log({
      event: 'register.success',
      actorUserId: user.userId,
      ip: params.ipAddress,
      userAgent: params.userAgent,
      detail: { email: user.profile.email, method: 'oauth', provider: params.provider },
    });

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

    const impersonationMeta: ImpersonationMeta | undefined =
      session.metadata?.isImpersonating
        ? {
            isImpersonating: true,
            impersonatedBy: session.metadata.impersonatedBy!,
            impersonatedByName: session.metadata.impersonatedByName!,
          }
        : undefined;

    return {
      success: true,
      user,
      session: { session, token },
      impersonationMeta,
    };
  }

  /**
   * Logout (revoke session)
   */
  async logout(token: string): Promise<boolean> {
    const result = await this.sessionService.revokeSession(token, 'logout');

    // Audit log: explicit logout (Req 6.5.1)
    if (result) {
      // Resolve the userId from the session for the audit log
      try {
        const tokenHash = hashSessionToken(token);
        const session = await this.sessionService.getByTokenHash(tokenHash);
        await auditLogger.log({
          event: 'logout',
          actorUserId: session?.userId,
          ip: session?.metadata?.ipAddress,
          userAgent: session?.metadata?.userAgent,
        });
      } catch {
        // Best-effort — the session is already revoked
      }
    }

    return result;
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
      // API tokens are bearer credentials too: a new password must cut them off (SEC-5)
      const apiTokensRevoked = await revokeUserApiTokens(this.db, userId);

      // Audit log: password changed (Req 6.5.1)
      await auditLogger.log({
        event: 'password.change',
        actorUserId: userId,
        detail: { sessionsRevoked: true, apiTokensRevoked },
      });

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
  // MFA (Multi-Factor Authentication)
  // ============================================================================

  /**
   * Complete an MFA challenge issued during login.
   * Verifies the TOTP code (or backup code) and creates a session if valid.
   *
   * @param challengeToken - Token returned from loginWithPassword when MFA is required
   * @param mfaCode - 6-digit TOTP code or backup code
   * @returns AuthResult with session on success
   */
  async completeMFAChallenge(challengeToken: string, mfaCode: string): Promise<AuthResult> {
    // Look up the challenge
    const challenge = this.mfaChallenges.get(challengeToken);
    if (!challenge) {
      return {
        success: false,
        error: 'MFA challenge not found or expired',
        errorCode: 'mfa_invalid',
      };
    }

    // Check expiry
    if (challenge.expiresAt < new Date()) {
      this.mfaChallenges.delete(challengeToken);
      return {
        success: false,
        error: 'MFA challenge expired',
        errorCode: 'mfa_invalid',
      };
    }

    // Verify the MFA code
    const mfaResult = await this.mfaService.verifyMFA(challenge.userId, mfaCode);
    if (!mfaResult.success) {
      // Audit log: MFA verification failed (Req 6.5.1)
      await auditLogger.log({
        event: 'login.mfa_failure',
        actorUserId: challenge.userId,
        ip: challenge.ipAddress,
        userAgent: challenge.userAgent,
        detail: { reason: mfaResult.error },
      });

      return {
        success: false,
        error: mfaResult.error || 'Invalid MFA code',
        errorCode: 'mfa_invalid',
      };
    }

    // MFA verified — clean up the challenge and create a session
    this.mfaChallenges.delete(challengeToken);

    const user = await this.userService.getByUserId(challenge.userId);
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

    const session = await this.sessionService.createSession({
      userId: challenge.userId,
      identityId: challenge.identityId,
      userAgent: challenge.userAgent,
      ipAddress: challenge.ipAddress,
    });

    // Update last login
    await this.userService.updateLastLogin(user.userId);
    await this.ensureSignInDefaults(user.userId);

    // Audit log: successful MFA login (Req 6.5.1)
    await auditLogger.log({
      event: 'login.mfa_success',
      actorUserId: user.userId,
      ip: challenge.ipAddress,
      userAgent: challenge.userAgent,
      detail: { method: 'password+mfa' },
    });

    return {
      success: true,
      user,
      session,
    };
  }

  /**
   * Start MFA setup for a user.
   * Generates a TOTP secret and backup codes. The user must scan the QR code
   * and verify with a TOTP code via enableMFA() to complete setup.
   *
   * @returns Setup result with secret, QR URI, and backup codes
   */
  async setupMFA(userId: string): Promise<MFASetupResult> {
    return this.mfaService.setupMFA(userId);
  }

  /**
   * Enable MFA after the user verifies with a TOTP code.
   */
  async enableMFA(userId: string, totpCode: string): Promise<boolean> {
    return this.mfaService.enableMFA(userId, totpCode);
  }

  /**
   * Disable MFA. Requires a valid TOTP code or backup code.
   */
  async disableMFA(userId: string, code: string): Promise<boolean> {
    return this.mfaService.disableMFA(userId, code);
  }

  /**
   * Get MFA status for a user (for UI display).
   */
  async getMFAStatus(userId: string) {
    return this.mfaService.getMFAStatus(userId);
  }

  /**
   * Regenerate backup codes for a user.
   */
  async regenerateBackupCodes(userId: string): Promise<string[]> {
    return this.mfaService.regenerateBackupCodes(userId);
  }

  /**
   * Check if MFA is enabled for a user.
   */
  async isMFAEnabled(userId: string): Promise<boolean> {
    return this.mfaService.isMFAEnabled(userId);
  }

  /**
   * Remove expired MFA challenge tokens from the in-memory store.
   * Called opportunistically during login — fire and forget.
   */
  private cleanupExpiredMFAChallenges(): void {
    const now = new Date();
    for (const [token, challenge] of this.mfaChallenges) {
      if (challenge.expiresAt < now) {
        this.mfaChallenges.delete(token);
      }
    }
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
