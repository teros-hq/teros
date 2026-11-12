/**
 * admin-api.users — user management (admin), MCA-facing
 *
 * Actions:
 *   admin-api.users-grant-access → grant platform access to a waitlisted user
 *   admin-api.users-update-role  → change a user's role (user | admin | super)
 *
 * These are thin admin-api wrappers over the SAME UserService methods the
 * UI-domain handlers use (admin.grant-access / admin.update-user-role in
 * domains/admin/): UserService.grantAccess() and UserService.updateRole().
 * No logic is reimplemented here — authorization and validation mirror the UI
 * handlers exactly so the error surface and privilege boundaries are identical:
 *   - grant-access: admin | super  (same as admin.grant-access)
 *   - update-role:  super only     (same as admin.update-user-role — no
 *     privilege escalation via the MCA path) + the same role.change audit log
 *
 * Step-up: intentionally NOT required here. The UI handlers call
 * requireStepUp() because they run on a user session; this domain is reached
 * through the MCA bridge (McaConnectionManager.handleAdminRequest), whose ctx
 * carries no sessionToken — step-up cannot be verified there (it would always
 * throw STEP_UP_REQUIRED). The MCA path is authenticated by the role check
 * below on the app owner's resolved user, and the tool itself is alwaysAsk
 * (human confirmation on every single call).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { UserService } from '../../../auth/user-service'
import type { User } from '../../../auth/types'
import { auditLogger } from '../../../lib/audit-logger'

/** admin | super — same criterion as the UI admin.grant-access handler. */
async function getCaller(db: Db, userId: string): Promise<User> {
  const caller = await db.collection('users').findOne({ userId })
  if (!caller || (caller.role !== 'admin' && caller.role !== 'super')) {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
  return caller as User
}

interface UsersGrantAccessData {
  userId: string
}

export function createUsersGrantAccessHandler(db: Db, userService?: UserService | null) {
  const users = userService ?? new UserService(db)

  return async function usersGrantAccess(ctx: WsHandlerContext, rawData: unknown) {
    await getCaller(db, ctx.userId)
    const data = (rawData ?? {}) as UsersGrantAccessData

    if (!data.userId) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required field: userId')
    }

    const target = await users.getByUserId(data.userId)
    if (!target) {
      throw new HandlerError(
        'USER_NOT_FOUND',
        `User '${data.userId}' not found. Check the userId in the admin panel (Users window) and retry.`,
      )
    }

    if (target.accessGranted) {
      throw new HandlerError(
        'ALREADY_GRANTED',
        `User '${data.userId}' already has access (accessGranted: true). Nothing to do.`,
      )
    }

    const updatedUser = await users.grantAccess(data.userId)
    if (!updatedUser) {
      throw new HandlerError('USER_NOT_FOUND', `User '${data.userId}' not found`)
    }

    console.log(`✅ [admin-api.users-grant-access] User ${data.userId} access granted by ${ctx.userId}`)

    return {
      user: {
        userId: updatedUser.userId,
        accessGranted: updatedUser.accessGranted,
      },
      note: updatedUser.accessGranted
        ? 'Access granted — the user gets the access-granted email when email is configured.'
        : 'Access did not change — the user was already granted (no email re-sent).',
    }
  }
}

interface UsersUpdateRoleData {
  userId: string
  role: User['role']
}

export function createUsersUpdateRoleHandler(db: Db, userService?: UserService | null) {
  const users = userService ?? new UserService(db)

  return async function usersUpdateRole(ctx: WsHandlerContext, rawData: unknown) {
    const caller = await getCaller(db, ctx.userId)
    if (caller.role !== 'super') {
      throw new HandlerError(
        'FORBIDDEN',
        'Super admin privileges required — role changes are super-only (same as the admin panel).',
      )
    }

    const data = (rawData ?? {}) as UsersUpdateRoleData

    if (!data.userId || !data.role) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: userId, role')
    }

    if (!['user', 'admin', 'super'].includes(data.role)) {
      throw new HandlerError(
        'INVALID_ROLE',
        `Invalid role '${data.role}'. Role must be one of: user, admin, super.`,
      )
    }

    if (data.userId === ctx.userId && data.role !== 'super') {
      throw new HandlerError(
        'SELF_DEMOTION',
        'Cannot demote yourself — ask another super admin to change your role.',
      )
    }

    const target = await users.getByUserId(data.userId)
    if (!target) {
      throw new HandlerError(
        'USER_NOT_FOUND',
        `User '${data.userId}' not found. Check the userId in the admin panel (Users window) and retry.`,
      )
    }

    const updatedUser = await users.updateRole(data.userId, data.role)
    if (!updatedUser) {
      throw new HandlerError('USER_NOT_FOUND', `User '${data.userId}' not found`)
    }

    // Audit log: user role changed (Req 6.5.1) — same event the UI handler
    // writes, with the target's real previous role and the MCA origin marked.
    await auditLogger.log({
      event: 'role.change',
      actorUserId: ctx.userId,
      targetUserId: data.userId,
      ip: ctx.ip,
      detail: { newRole: data.role, previousRole: target.role, via: 'mca' },
    })

    console.log(`✅ [admin-api.users-update-role] User ${data.userId} role → ${data.role} by ${ctx.userId}`)

    return {
      user: {
        userId: updatedUser.userId,
        role: updatedUser.role,
      },
    }
  }
}
