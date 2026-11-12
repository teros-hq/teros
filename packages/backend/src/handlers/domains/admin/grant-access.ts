/**
 * admin.grant-access — Grant platform access to a waitlisted user (admin/super only, step-up required)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserService } from '../../../auth/user-service'
import type { SessionService } from '../../../auth/session-service'
import { requireStepUp } from './require-step-up'

interface GrantAccessData {
  targetUserId: string
}

export function createGrantAccessHandler(
  userService: UserService,
  sessionService: SessionService,
) {
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

    // Step-up auth: require recent re-authentication (Req 2.4.1)
    await requireStepUp(ctx, sessionService)

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
