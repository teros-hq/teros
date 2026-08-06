/**
 * admin.impersonate        — Start impersonating a target user (super only)
 * admin.stop-impersonation — Stop impersonating and restore the admin's session
 */

import { createHash } from 'crypto'
import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { UserService } from '../../../auth/user-service'
import { IdentityService } from '../../../auth/identity-service'
import { SessionService, hashSessionToken } from '../../../auth/session-service'

// ============================================================================
// admin.impersonate
// ============================================================================

interface ImpersonateData {
  targetUserId: string
}

export function createImpersonateHandler(
  userService: UserService,
  identityService: IdentityService,
  sessionService: SessionService,
) {
  return async function impersonate(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ImpersonateData

    // 1. Verify caller is super
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Super admin privileges required')
    }

    // 2. Validate payload
    const { targetUserId } = data
    if (!targetUserId) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId is required')
    }

    // 3. Verify caller's current session is NOT already an impersonation session
    //    (no nested impersonation)
    if (!ctx.sessionToken) {
      throw new HandlerError('INTERNAL_ERROR', 'Session token not available in context')
    }
    const callerTokenHash = hashSessionToken(ctx.sessionToken)
    const callerSession = await sessionService.getByTokenHash(callerTokenHash)
    if (!callerSession) {
      throw new HandlerError('SESSION_NOT_FOUND', 'Current session not found')
    }
    if (callerSession.metadata?.isImpersonating) {
      throw new HandlerError(
        'NESTED_IMPERSONATION',
        'Cannot impersonate while already in an impersonation session',
      )
    }

    // 4. Validate target user
    if (targetUserId === ctx.userId) {
      throw new HandlerError('INVALID_TARGET', 'Cannot impersonate yourself')
    }

    const targetUser = await userService.getByUserId(targetUserId)
    if (!targetUser) {
      throw new HandlerError('USER_NOT_FOUND', 'Target user not found')
    }
    if (targetUser.role === 'super') {
      throw new HandlerError('FORBIDDEN', 'Cannot impersonate another super admin')
    }
    if (targetUser.status === 'suspended') {
      throw new HandlerError('USER_SUSPENDED', 'Cannot impersonate a suspended user')
    }

    // 5. Get an identityId to associate with the new session.
    //    We reuse the admin's own identityId from their current session.
    const identityId = callerSession.identityId

    // 6. Create impersonation session (2-hour TTL, carries originalTokenHash)
    const { session: impersonationSession, token: impersonationToken } =
      await sessionService.createImpersonationSession({
        targetUserId,
        adminUserId: ctx.userId,
        adminDisplayName: caller.profile.displayName,
        originalTokenHash: callerTokenHash,
        identityId,
        ipAddress: ctx.ip,
      })

    // 7. Audit log
    console.log(
      `[AUDIT] admin.impersonate: admin=${ctx.userId} (${caller.profile.displayName}) ` +
        `→ target=${targetUserId} (${targetUser.profile.displayName}) ` +
        `ip=${ctx.ip} sessionId=${impersonationSession._id.toHexString()}`,
    )

    return {
      impersonationToken,
      targetUser: {
        userId: targetUser.userId,
        displayName: targetUser.profile.displayName,
        email: targetUser.profile.email,
        avatarUrl: targetUser.profile.avatarUrl,
        role: targetUser.role,
        accessGranted: targetUser.accessGranted,
      },
      expiresAt: impersonationSession.expiresAt.toISOString(),
    }
  }
}

// ============================================================================
// admin.stop-impersonation
// ============================================================================

export function createStopImpersonationHandler(
  userService: UserService,
  sessionService: SessionService,
) {
  return async function stopImpersonation(ctx: WsHandlerContext, _rawData: unknown) {
    // 1. Ensure we have the current token
    if (!ctx.sessionToken) {
      throw new HandlerError('INTERNAL_ERROR', 'Session token not available in context')
    }

    // 2. Find the current session and verify it IS an impersonation session
    const currentTokenHash = hashSessionToken(ctx.sessionToken)
    const currentSession = await sessionService.getByTokenHash(currentTokenHash)
    if (!currentSession) {
      throw new HandlerError('SESSION_NOT_FOUND', 'Current session not found')
    }
    if (!currentSession.metadata?.isImpersonating) {
      throw new HandlerError(
        'NOT_IMPERSONATING',
        'Current session is not an impersonation session',
      )
    }

    // 3. Retrieve the admin's original session via originalTokenHash
    const originalTokenHash = currentSession.metadata.originalTokenHash
    if (!originalTokenHash) {
      throw new HandlerError(
        'MISSING_ORIGINAL_TOKEN',
        'Original admin token hash not found in session metadata',
      )
    }

    const originalSession = await sessionService.getByTokenHash(originalTokenHash)
    if (!originalSession) {
      throw new HandlerError(
        'ORIGINAL_SESSION_EXPIRED',
        'The original admin session has expired or been revoked. Please log in again.',
      )
    }

    // 4. Revoke the impersonation session
    await sessionService.revokeSession(ctx.sessionToken, 'admin')

    // 5. Create a fresh token for the admin (we cannot return the original token
    //    in plaintext since only the hash is stored). We refresh the original session
    //    using its hash — this generates a new token and extends the expiry.
    const refreshed = await sessionService.refreshSessionByHash(originalTokenHash)
    if (!refreshed) {
      throw new HandlerError(
        'REFRESH_FAILED',
        'Failed to refresh original admin session',
      )
    }

    // 6. Audit log
    const adminUserId = originalSession.userId
    const admin = await userService.getByUserId(adminUserId)
    console.log(
      `[AUDIT] admin.stop-impersonation: admin=${adminUserId} (${admin?.profile.displayName ?? 'unknown'}) ` +
        `stopped impersonating userId=${currentSession.userId} ip=${ctx.ip}`,
    )

    return {
      restoredToken: refreshed.token,
      adminUserId,
    }
  }
}
