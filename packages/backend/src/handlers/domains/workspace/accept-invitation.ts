/**
 * workspace.accept_invitation — Accept a pending workspace invitation
 *
 * MUW-14 Fase 2 (Pablo, 2026-10-27): every invitation requires explicit
 * acceptance. The invitee opens Teros from the email CTA
 * (`/?invite_email=...&invite_token=...`) or sees the pending-invitations
 * banner, and accepts — only then does the membership become active.
 *
 * Identity model: the token (from the wire) identifies the invitation; the
 * authenticated session identifies the person. The session account's email is
 * resolved SERVER-SIDE (userService) and MUST match the invited email
 * (workspaceService.acceptInvitation guard) — a leaked token alone can never
 * grant membership, and a client-supplied email is never trusted.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'

interface AcceptInvitationData {
  inviteToken: string
}

export function createAcceptInvitationHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
) {
  return async function acceptInvitation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AcceptInvitationData

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
      const result = await workspaceService.acceptInvitation(
        data.inviteToken,
        ctx.userId,
        sessionEmail,
      )

      return {
        accepted: true,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        role: result.role,
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'INVITATION_NOT_FOUND') {
        throw new HandlerError(
          'INVITATION_NOT_FOUND',
          'This invitation is no longer valid — it may have been revoked, declined, already accepted, or the token is incorrect.',
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
