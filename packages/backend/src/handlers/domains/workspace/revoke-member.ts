/**
 * workspace.revoke_member — Revoke a pending membership and cancel its invitation
 *
 * MUW-14: Invitations & pending membership (spec v1.4.0, REQ-15, AC-18)
 *
 * Authorization: canManageMembers (owner/admin only — REQ-17)
 * The member entry is removed entirely — a revoked workspace never appears for the invitee.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface RevokeMemberData {
  workspaceId: string
  email: string
}

export function createRevokeMemberHandler(workspaceService: WorkspaceService) {
  return async function revokeMember(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RevokeMemberData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }
    if (!data.email) {
      throw new HandlerError('MISSING_EMAIL', 'email is required')
    }

    // Authorization: only owner or admin can revoke members
    if (!(await workspaceService.canManageMembers(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'Only workspace admins can manage members')
    }

    try {
      const success = await workspaceService.revokePendingMember(
        data.workspaceId,
        data.email,
        ctx.userId,
      )

      return {
        success,
        workspaceId: data.workspaceId,
        email: data.email.toLowerCase(),
      }
    } catch (e) {
      // Map known errors to HandlerError
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
