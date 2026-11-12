/**
 * workspace.resend_invitation — Resend the platform invitation email for a pending member
 *
 * MUW-14: Invitations & pending membership (spec v1.4.0, REQ-16, AC-19)
 *
 * Authorization: canManageMembers (owner/admin only — REQ-17)
 * Rate-limited to 1 per minute per member.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'
import { buildInvitationEmailSendFn } from './invitation-email'

interface ResendInvitationData {
  workspaceId: string
  email: string
}

export function createResendInvitationHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
  db: Db,
) {
  return async function resendInvitation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ResendInvitationData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!data.email) {
      throw new HandlerError('MISSING_EMAIL', 'email is required')
    }

    // Authorization: only owner or admin can resend invitations
    if (!(await workspaceService.canManageMembers(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
    }

    // Build the email send function (shared helper — fixes the latent
    // bare-require() ESM bug the inline copy carried).
    const emailSendFn = buildInvitationEmailSendFn(userService, db, ctx.userId, {
      logTag: 'workspace.resend_invitation',
    })

    try {
      const result = await workspaceService.resendInvitation(
        data.workspaceId,
        data.email,
        ctx.userId,
        emailSendFn,
      )

      if (result.rateLimited) {
        throw new HandlerError(
          'RATE_LIMITED',
          'Invitation email was sent recently — try again in a minute',
        )
      }

      return {
        success: result.sent,
        workspaceId: data.workspaceId,
        email: data.email.toLowerCase(),
        emailSent: result.sent,
      }
    } catch (e) {
      if (e instanceof HandlerError) throw e
      if (e instanceof Error && e.message === 'MEMBER_NOT_PENDING') {
        throw new HandlerError(
          'MEMBER_NOT_PENDING',
          'This member is already active — remove them instead',
        )
      }
      throw e
    }
  }
}
