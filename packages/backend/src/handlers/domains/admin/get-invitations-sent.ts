/**
 * admin.get-invitations-sent — Get list of invitations sent by current user
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { InvitationService } from '../../../auth/invitation-service'

export function createGetInvitationsSentHandler(db: Db) {
  return async function getInvitationsSent(ctx: WsHandlerContext, _rawData: unknown) {
    const invitationService = new InvitationService(db)
    const result = await invitationService.getInvitationsSent(ctx.userId)

    return {
      invitations: result.invitations.map((inv) => ({
        toUserId: inv.toUserId,
        toEmail: inv.toEmail,
        toDisplayName: inv.toDisplayName,
        createdAt: inv.createdAt.toISOString(),
        recipientAccessGranted: inv.recipientAccessGranted,
      })),
    }
  }
}
