/**
 * admin.revoke-invitation — Revoke an invitation (admin only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { InvitationService } from '../../../auth/invitation-service'
import { UserService } from '../../../auth/user-service'

interface RevokeInvitationData {
  fromUserId: string
  toUserId: string
}

export function createRevokeInvitationHandler(db: Db) {
  return async function revokeInvitation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RevokeInvitationData

    const userService = new UserService(db)
    const caller = await userService.getByUserId(ctx.userId)
    if (caller?.role !== 'admin' && caller?.role !== 'super') {
      throw new HandlerError('FORBIDDEN', 'Admin privileges required to revoke invitations')
    }

    const { fromUserId, toUserId } = data
    if (!fromUserId || !toUserId) {
      throw new HandlerError('MISSING_FIELDS', 'fromUserId and toUserId are required')
    }

    const invitationService = new InvitationService(db)
    const result = await invitationService.revokeInvitation(fromUserId, toUserId)

    if (!result.success) {
      throw new HandlerError('REVOKE_FAILED', result.error || 'Failed to revoke invitation')
    }

    return {
      fromUserId,
      toUserId,
      accessRevoked: result.accessRevoked || false,
    }
  }
}
