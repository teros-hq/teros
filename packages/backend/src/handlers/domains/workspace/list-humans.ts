/**
 * workspace.list-humans — List all human members of a workspace
 *
 * Returns all human members with profile data (displayName, avatarUrl, email).
 * Includes both the workspace owner and all active members from the workspace_members collection.
 * Pending members (no userId yet) are excluded — they can't be assigned tasks.
 *
 * Unlike `workspace.get` (which strips userId per Guard 2), this handler returns
 * userId because it is specifically for building member selectors within the workspace.
 * Only active workspace members can call it.
 *
 * Access: any active workspace member.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'

interface ListHumansData {
  workspaceId: string
}

interface HumanMember {
  userId: string
  displayName: string
  avatarUrl?: string
  email: string
  role: string
  status: string
}

export function createListWorkspaceHumansHandler(
  workspaceService: WorkspaceService,
  userService: UserService,
) {
  return async function listWorkspaceHumans(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListHumansData

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

    // Collect all userIds to resolve: owner + active members with a userId
    const userIds = new Set<string>()
    userIds.add(workspace.ownerId)

    // Single source of truth: workspace_members collection (not embedded array)
    const members = await workspaceService.getWorkspaceMembers(data.workspaceId)
    const memberMap = new Map<string, { role: string; status: string }>()

    for (const m of members) {
      const status = m.status ?? 'active'
      if (status === 'active' && m.userId) {
        userIds.add(m.userId)
        memberMap.set(m.userId, { role: m.role, status })
      }
    }

    // Resolve profiles for all humans
    const humans: HumanMember[] = []

    for (const userId of userIds) {
      try {
        const user = await userService.getByUserId(userId)
        if (!user) continue

        // Determine role: owner gets 'owner', members get their role
        const isOwner = userId === workspace.ownerId
        const memberInfo = memberMap.get(userId)
        const role = isOwner ? 'owner' : (memberInfo?.role ?? 'read')
        const status = isOwner ? 'active' : (memberInfo?.status ?? 'active')

        humans.push({
          userId,
          displayName: user.profile.displayName,
          avatarUrl: buildAvatarUrl(user.profile.avatarUrl),
          email: user.profile.email,
          role,
          status,
        })
      } catch {
        // Skip users that can't be resolved (e.g. deleted accounts)
      }
    }

    return {
      workspaceId: data.workspaceId,
      humans,
    }
  }
}
