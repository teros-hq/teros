/**
 * admin.update-user-role — Update a user's role (super only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { User } from '../../../auth/types'

interface UpdateUserRoleData {
  targetUserId: string
  role: User['role']
}

export function createUpdateUserRoleHandler(userService: UserService) {
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

    const updatedUser = await userService.updateRole(targetUserId, role)
    if (!updatedUser) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    console.log(`✅ User ${targetUserId} role updated to ${role} by ${ctx.userId}`)

    return {
      user: {
        userId: updatedUser.userId,
        role: updatedUser.role,
      },
    }
  }
}
