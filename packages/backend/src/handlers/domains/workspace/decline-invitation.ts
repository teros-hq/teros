/**
 * workspace.decline_invitation — Decline a pending workspace invitation
 *
 * MUW-14 Fase 2 (Pablo, 2026-10-27): the invitee can reject the invitation.
 * The pending member entry is removed entirely (same end-state as a revoke,
 * but performed by the invitee) — no residue, and the workspace never
 * appears for this email unless someone invites them again.
 *
 * Same identity model as accept: the token (from the wire) identifies the
 * invitation; the session account's email is resolved SERVER-SIDE and must
 * match the invited email.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'

interface DeclineInvitationData {
  inviteToken: string
}

export function createDeclineInvitationHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
) {
  return async function declineInvitation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeclineInvitationData

    if (!data.inviteToken) {
      throw new HandlerError('MISSING_TOKEN', 'inviteToken is required')
    }

    // Resolve the authenticated account's email — never trust the wire
    const user = await userService.getByUserId(ctx.userId)
    const sessionEmail = user?.profile?.email
    if (!sessionEmail) {
      throw new HandlerError('EMAIL_NOT_FOUND', 'No email on record for this account')
    }

    try {
      const result = await workspaceService.declineInvitation(
        data.inviteToken,
        ctx.userId,
        sessionEmail,
      )

      return {
        declined: true,
        workspaceId: result.workspaceId,
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'INVITATION_NOT_FOUND') {
        throw new HandlerError(
          'INVITATION_NOT_FOUND',
          'This invitation is no longer valid — it may have been revoked, already accepted, or the token is incorrect.',
        )
      }
      if (e instanceof Error && e.message === 'INVITATION_EMAIL_MISMATCH') {
        throw new HandlerError(
          'INVITATION_EMAIL_MISMATCH',
          'This invitation was sent to a different email address than your account.',
        )
      }
      throw e
    }
  }
}
