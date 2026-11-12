/**
 * admin.update-user-role — Update a user's role (super only, step-up required)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { SessionService } from '../../../auth/session-service'
import type { User } from '../../../auth/types'
import { auditLogger } from '../../../lib/audit-logger'
import { requireStepUp } from './require-step-up'

interface UpdateUserRoleData {
  targetUserId: string
  role: User['role']
}

export function createUpdateUserRoleHandler(
  userService: UserService,
  sessionService: SessionService,
) {
  return async function updateUserRole(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateUserRoleData

    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Super admin privileges required')
    }

    const { targetUserId, role } = data
    if (!targetUserId || !role) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId and role are required')
    }

    if (!['user', 'admin', 'super'].includes(role)) {
      throw new HandlerError('INVALID_ROLE', 'Role must be user, admin, or super')
    }

    if (targetUserId === ctx.userId && role !== 'super') {
      throw new HandlerError('SELF_DEMOTION', 'Cannot demote yourself')
    }

    // Step-up auth: require recent re-authentication (Req 2.4.1)
    await requireStepUp(ctx, sessionService)

    const updatedUser = await userService.updateRole(targetUserId, role)
    if (!updatedUser) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    // Audit log: user role changed (Req 6.5.1)
    await auditLogger.log({
      event: 'role.change',
      actorUserId: ctx.userId,
      targetUserId,
      ip: ctx.ip,
      detail: { newRole: role, previousRole: caller.role },
    })

    return {
      user: {
        userId: updatedUser.userId,
        role: updatedUser.role,
      },
    }
  }
}
