/**
 * workspace.get — Get details of a specific workspace
 *
 * MUW-14 (Guard 2): userId is stripped from member entries in the response.
 * The inviter's name is resolved server-side (invitedBy → displayName).
 * If the inviter cannot be resolved, a safe placeholder ("Unknown") is used —
 * the raw userId is NEVER returned in any API response.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'
import type { WorkspaceMember } from '../../../types/database'

/** Safe placeholder when an inviter's display name cannot be resolved. */
const UNKNOWN_INVITER = 'Unknown'

interface GetWorkspaceData {
  workspaceId: string
}

/**
 * Strip userId from member entries and resolve invitedBy to display names.
 * userId is an internal field — it must never appear in API responses (Guard 2).
 * The owner's own userId is already known to the authenticated user.
 *
 * If an inviter's display name cannot be resolved (deleted user, lookup error,
 * or userService unavailable), a safe placeholder is used — never the raw userId.
 */
function sanitizeMembers(
  members: WorkspaceMember[],
  inviterNames: Map<string, string>,
): Array<Record<string, any>> {
  return members.map((m) => {
    const sanitized: Record<string, any> = {
      role: m.role,
      status: m.status ?? 'active',
      joinedAt: m.joinedAt,
      email: m.email,
    }

    // Resolve invitedBy to display name (never expose the raw userId — Guard 2)
    if (m.invitation) {
      sanitized.invitation = {
        // Guard 2: fallback is always a safe placeholder, never the raw userId
        invitedBy: inviterNames.get(m.invitation.invitedBy) ?? UNKNOWN_INVITER,
        invitedAt: m.invitation.invitedAt,
        sentAt: m.invitation.sentAt,
        acceptedAt: m.invitation.acceptedAt,
        cancelledAt: m.invitation.cancelledAt,
      }
    }

    return sanitized
  })
}

export function createGetWorkspaceHandler(
  workspaceService: WorkspaceService,
  userService?: UserService,
) {
  return async function getWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetWorkspaceData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!(await workspaceService.canAccess(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
    }

    const workspace = await workspaceService.getWorkspace(data.workspaceId)
    if (!workspace) {
      throw new HandlerError('WORKSPACE_NOT_FOUND', 'Workspace not found')
    }

    const role = await workspaceService.getUserRole(data.workspaceId, ctx.userId)

    // Fetch members from workspace_members collection (single source of truth)
    const members = await workspaceService.getWorkspaceMembers(data.workspaceId)

    // Resolve inviter display names for pending members (Guard 2: never expose userIds)
    const inviterIds = new Set<string>()
    for (const m of members) {
      if (m.invitation?.invitedBy) {
        inviterIds.add(m.invitation.invitedBy)
      }
    }

    const inviterNames = new Map<string, string>()
    if (userService && inviterIds.size > 0) {
      for (const inviterId of inviterIds) {
        try {
          const inviter = await userService.getByUserId(inviterId)
          // Guard 2: if user not found (deleted account), use safe placeholder — never raw userId
          inviterNames.set(
            inviterId,
            inviter?.profile?.displayName ?? UNKNOWN_INVITER,
          )
        } catch {
          // Guard 2: if lookup throws, use safe placeholder — never raw userId
          inviterNames.set(inviterId, UNKNOWN_INVITER)
        }
      }
    } else {
      // Guard 2: no userService — use safe placeholder for ALL inviter IDs, never raw userId
      for (const id of inviterIds) {
        inviterNames.set(id, UNKNOWN_INVITER)
      }
    }

    return {
      workspace: {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        description: workspace.description,
        context: workspace.context,
        volumeId: workspace.volumeId,
        ownerId: workspace.ownerId,
        // Guard 2: strip userId from all member entries
        members: sanitizeMembers(members, inviterNames),
        settings: workspace.settings,
        appearance: workspace.appearance,
        role,
        status: workspace.status,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    }
  }
}
