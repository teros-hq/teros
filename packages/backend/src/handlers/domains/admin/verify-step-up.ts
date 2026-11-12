/**
 * admin.verify-step-up — Re-authenticate for sensitive operations (Req 2.4.1)
 *
 * Before performing sensitive operations (role changes, impersonation, status
 * changes, access grants), the admin must re-verify their identity. This handler
 * accepts either:
 *   - The user's password (for accounts without MFA)
 *   - A TOTP code (for accounts with MFA enabled)
 *   - Auto-approval (for accounts with only OAuth identities, e.g. Google —
 *     they have no password to verify and already authenticated via Google)
 *
 * On success, it stamps `metadata.stepUpAt` on the session, granting a 10-minute
 * window during which sensitive operations are allowed.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { IdentityService } from '../../../auth/identity-service'
import type { SessionService } from '../../../auth/session-service'
import type { MFAService } from '../../../auth/mfa-service'
import { hashSessionToken, STEP_UP_WINDOW_MS } from '../../../auth/session-service'

interface VerifyStepUpData {
  /** User's password (required if MFA is not enabled and user has a password identity) */
  password?: string
  /** 6-digit TOTP code or backup code (required if MFA is enabled) */
  mfaCode?: string
}

export function createVerifyStepUpHandler(
  userService: UserService,
  identityService: IdentityService,
  sessionService: SessionService,
  mfaService: MFAService,
) {
  return async function verifyStepUp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as VerifyStepUpData

    // 1. Require a session token to identify the current session
    if (!ctx.sessionToken) {
      throw new HandlerError('INTERNAL_ERROR', 'Session token not available in context')
    }

    // 2. Look up the caller
    const caller = await userService.getByUserId(ctx.userId)
    if (!caller) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    // 3. Only admin/super can use step-up (it gates admin operations)
    if (caller.role !== 'admin' && caller.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    // 4. Find the current session
    const tokenHash = hashSessionToken(ctx.sessionToken)
    const session = await sessionService.getByTokenHash(tokenHash)
    if (!session) {
      throw new HandlerError('SESSION_NOT_FOUND', 'Current session not found')
    }

    // 5. Reject step-up from impersonation sessions — the real admin must
    //    re-authenticate on their own session, not from within an impersonation.
    if (session.metadata?.isImpersonating) {
      throw new HandlerError(
        'FORBIDDEN',
        'Cannot step-up authenticate from an impersonation session',
      )
    }

    // 6. Verify identity: MFA → password → OAuth auto-approve
    if (caller.mfa?.enabled) {
      // MFA path: require a TOTP code or backup code
      if (!data.mfaCode) {
        throw new HandlerError('MFA_REQUIRED', 'MFA code is required for step-up authentication')
      }
      const mfaResult = await mfaService.verifyMFA(ctx.userId, data.mfaCode)
      if (!mfaResult.success) {
        throw new HandlerError('MFA_INVALID', mfaResult.error || 'Invalid MFA code')
      }
    } else {
      // Check if the user has a password identity
      const hasPassword = await identityService.hasPasswordIdentity(ctx.userId)
      if (hasPassword) {
        // Password path: require the user's password
        if (!data.password) {
          throw new HandlerError('MISSING_FIELDS', 'Password is required for step-up authentication')
        }
        const verifyResult = await identityService.verifyPassword(
          caller.profile.email,
          data.password,
        )
        if (!verifyResult.success) {
          throw new HandlerError(
            'INVALID_CREDENTIALS',
            'Password verification failed',
          )
        }
      } else {
        // OAuth-only path: the user has no password and no MFA — they
        // authenticated via an OAuth provider (e.g. Google). Auto-approve
        // the step-up: they already proved their identity to Google to
        // get this session, and there's no password to re-verify.
        console.log(
          `[AUDIT] admin.verify-step-up: user=${ctx.userId} (${caller.profile.displayName}) ` +
            `ip=${ctx.ip} method=oauth-auto-approve (no password identity)`,
        )
      }
    }

    // 7. Stamp the session with stepUpAt
    const stamped = await sessionService.setStepUp(tokenHash)
    if (!stamped) {
      throw new HandlerError('INTERNAL_ERROR', 'Failed to set step-up timestamp on session')
    }

    const expiresAt = new Date(Date.now() + STEP_UP_WINDOW_MS)

    console.log(
      `[AUDIT] admin.verify-step-up: user=${ctx.userId} (${caller.profile.displayName}) ` +
        `ip=${ctx.ip} stepUpWindow=${STEP_UP_WINDOW_MS}ms expiresAt=${expiresAt.toISOString()}`,
    )

    return {
      verified: true,
      expiresAt: expiresAt.toISOString(),
    }
  }
}
