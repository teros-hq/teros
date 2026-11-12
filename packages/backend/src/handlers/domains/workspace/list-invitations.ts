/**
 * workspace.list_invitations — List pending invitations for the current user
 *
 * MUW-14 Fase 2 (Pablo, 2026-10-27): surfaces the invitations addressed to the
 * authenticated account's email so the frontend can show the
 * "You've been invited to X" banner. Covers both invitee shapes:
 * invited-before-account (created the account after being invited) and
 * invited-with-account (the invite found an existing account) — in the
 * unified flow both are pending until explicitly accepted.
 *
 * Guard 2: invitedBy is resolved to a display name server-side — the raw
 * userId is never returned.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'

/** Safe placeholder when an inviter's display name cannot be resolved. */
const UNKNOWN_INVITER = 'Unknown'

export function createListInvitationsHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
) {
  return async function listInvitations(ctx: WsHandlerContext, _rawData: unknown) {
    // Resolve the authenticated account's email — invitations are keyed by email
    const user = await userService.getByUserId(ctx.userId)
    const email = user?.profile?.email
    if (!email) {
      throw new HandlerError('EMAIL_NOT_FOUND', 'No email on record for this account')
    }

    const invitations = await workspaceService.listPendingInvitationsForEmail(email)
    if (invitations.length === 0) {
      return { invitations: [] }
    }

    // Resolve inviter display names (Guard 2: never expose raw userIds)
    const inviterIds = [...new Set(invitations.map((inv) => inv.invitedBy))]
    const inviterNames = new Map<string, string>()
    for (const inviterId of inviterIds) {
      try {
        const inviter = await userService.getByUserId(inviterId)
        inviterNames.set(inviterId, inviter?.profile?.displayName ?? UNKNOWN_INVITER)
      } catch {
        inviterNames.set(inviterId, UNKNOWN_INVITER)
      }
    }

    return {
      invitations: invitations.map((inv) => ({
        workspaceId: inv.workspaceId,
        workspaceName: inv.workspaceName,
        role: inv.role,
        invitedBy: inviterNames.get(inv.invitedBy) ?? UNKNOWN_INVITER,
        invitedAt: inv.invitedAt,
        inviteToken: inv.inviteToken,
      })),
    }
  }
}
