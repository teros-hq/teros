/**
 * workspace.list-members — Unified list of all workspace members (agents + humans)
 *
 * Combines workspace.list-agents and workspace.list-humans into a single response.
 * This is the primary endpoint the frontend uses to populate member selectors.
 *
 * Access: any active workspace member.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db, Filter } from 'mongodb'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import { usableAgentFilter } from '../../../services/channel-authz'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { UserService } from '../../../auth/user-service'

interface Agent {
  agentId: string
  coreId: string
  ownerId: string
  workspaceId?: string
  name: string
  fullName: string
  role: string
  avatarUrl?: string
}

interface AgentCore {
  coreId: string
  avatarUrl?: string
}

interface ListMembersData {
  workspaceId: string
}

interface UnifiedMember {
  id: string
  type: 'agent' | 'human'
  name: string
  fullName?: string
  avatarUrl?: string
  role?: string
  email?: string
}

export function createListWorkspaceMembersHandler(
  db: Db,
  workspaceService: WorkspaceService,
  userService: UserService,
) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function listWorkspaceMembers(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListMembersData

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

    // ── Agents ──────────────────────────────────────────────────────────
    const workspaceOwnerId = workspace.ownerId
    const agentList = await agents
      .find(usableAgentFilter(ctx.userId, data.workspaceId, workspaceOwnerId) as Filter<Agent>)
      .toArray()

    const cores = await agentCores.find({}).toArray()
    const coreMap = new Map(cores.map((c) => [c.coreId, c]))

    const members: UnifiedMember[] = agentList.map((a) => {
      const core = coreMap.get(a.coreId)
      const avatarUrl = a.avatarUrl || core?.avatarUrl
      return {
        id: a.agentId,
        type: 'agent' as const,
        name: a.name,
        fullName: a.fullName,
        avatarUrl: buildAvatarUrl(avatarUrl),
        role: a.role,
      }
    })

    // ── Humans (owner + active members) ─────────────────────────────────
    // Single source of truth: workspace_members collection (not embedded array)
    const wsMembers = await workspaceService.getWorkspaceMembers(data.workspaceId)
    const memberMap = new Map<string, { role: string; status: string }>()

    const userIds = new Set<string>()
    userIds.add(workspace.ownerId)

    for (const m of wsMembers) {
      const status = m.status ?? 'active'
      if (status === 'active' && m.userId) {
        userIds.add(m.userId)
        memberMap.set(m.userId, { role: m.role, status })
      }
    }

    for (const userId of userIds) {
      try {
        const user = await userService.getByUserId(userId)
        if (!user) continue

        const isOwner = userId === workspace.ownerId
        const memberInfo = memberMap.get(userId)
        const role = isOwner ? 'owner' : (memberInfo?.role ?? 'read')

        members.push({
          id: userId,
          type: 'human' as const,
          name: user.profile.displayName,
          avatarUrl: buildAvatarUrl(user.profile.avatarUrl),
          role,
          email: user.profile.email,
        })
      } catch {
        // Skip users that can't be resolved (e.g. deleted accounts)
      }
    }

    return {
      workspaceId: data.workspaceId,
      members,
    }
  }
}
