/**
 * admin.get-invitable-users — Get users that can be invited
 */

import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { InvitationService } from '../../../auth/invitation-service'

interface GetInvitableUsersData {
  limit?: number
}

export function createGetInvitableUsersHandler(db: Db) {
  return async function getInvitableUsers(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetInvitableUsersData
    const invitationService = new InvitationService(db)
    const users = await invitationService.getInvitableUsers(ctx.userId, data.limit || 20)

    return {
      users: users.map((u) => ({
        userId: u.userId,
        displayName: u.displayName,
        email: u.email,
        avatarUrl: u.avatarUrl,
        invitationsReceived: u.invitationsReceived,
        invitationsNeeded: 3 - u.invitationsReceived,
      })),
    }
  }
}
