/**
 * admin.grant-access — Grant platform access to a waitlisted user (admin/super only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'

interface GrantAccessData {
  targetUserId: string
}

export function createGrantAccessHandler(userService: UserService) {
  return async function grantAccess(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GrantAccessData

    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'super' && caller?.role !== 'admin') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { targetUserId } = data
    if (!targetUserId) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId is required')
    }

    const target = await userService.getByUserId(targetUserId)
    if (!target) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    if (target.accessGranted) {
      throw new HandlerError('ALREADY_GRANTED', 'User already has access')
    }

    const updatedUser = await userService.grantAccess(targetUserId)
    if (!updatedUser) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    console.log(`✅ User ${targetUserId} access granted (skip queue) by ${ctx.userId}`)

    return {
      user: {
        userId: updatedUser.userId,
        accessGranted: updatedUser.accessGranted,
      },
    }
  }
}
