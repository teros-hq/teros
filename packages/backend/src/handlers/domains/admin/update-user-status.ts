/**
 * admin.update-user-status — Update a user's status (admin only, step-up required)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { SessionService } from '../../../auth/session-service'
import type { User } from '../../../auth/types'
import { requireStepUp } from './require-step-up'

interface UpdateUserStatusData {
  targetUserId: string
  status: User['status']
}

export function createUpdateUserStatusHandler(
  userService: UserService,
  sessionService: SessionService,
) {
  return async function updateUserStatus(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateUserStatusData

    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required')
    }

    const { targetUserId, status } = data
    if (!targetUserId || !status) {
      throw new HandlerError('MISSING_FIELDS', 'targetUserId and status are required')
    }

    if (!['active', 'suspended', 'pending_verification'].includes(status)) {
      throw new HandlerError('INVALID_STATUS', 'Invalid status value')
    }

    if (targetUserId === ctx.userId && status === 'suspended') {
      throw new HandlerError('SELF_SUSPENSION', 'Cannot suspend yourself')
    }

    // Step-up auth: require recent re-authentication (Req 2.4.1)
    await requireStepUp(ctx, sessionService)

    const targetUser = await userService.getByUserId(targetUserId)
    if (!targetUser) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    if (targetUser.role === 'super' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Cannot modify super admin')
    }

    await userService.updateStatus(targetUserId, status)

    console.log(`✅ User ${targetUserId} status updated to ${status} by ${ctx.userId}`)

    return {
      user: {
        userId: targetUserId,
        status,
      },
    }
  }
}
