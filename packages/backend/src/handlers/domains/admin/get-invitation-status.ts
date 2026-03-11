/**
 * admin.get-invitation-status — Get current user's invitation status
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { InvitationService } from '../../../auth/invitation-service'

export function createGetInvitationStatusHandler(db: Db) {
  return async function getInvitationStatus(ctx: WsHandlerContext, _rawData: unknown) {
    const invitationService = new InvitationService(db)

    const status = await invitationService.getInvitationStatus(ctx.userId)
    if (!status) {
      throw new HandlerError('USER_NOT_FOUND', 'User not found')
    }

    const availableInvitations = await invitationService.getInvitationsRemaining(ctx.userId)

    return {
      ...status,
      availableInvitations,
      invitations: status.invitations.map((inv) => ({
        fromUserId: inv.fromUserId,
        sender: inv.sender,
        createdAt: inv.createdAt.toISOString(),
      })),
    }
  }
}
