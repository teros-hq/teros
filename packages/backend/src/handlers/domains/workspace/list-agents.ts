/**
 * workspace.list-agents — List all agents in a workspace
 *
 * Returns workspace agents + superagents with access. This is the workspace-domain
 * equivalent of `agent.list` scoped to a workspace, but with a trimmed response shape
 * (only fields needed for member selectors).
 *
 * Access: any active workspace member.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db, Filter } from 'mongodb'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import { usableAgentFilter } from '../../../services/channel-authz'
import type { WorkspaceService } from '../../../services/workspace-service'

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

interface ListAgentsData {
  workspaceId: string
}

export function createListWorkspaceAgentsHandler(
  db: Db,
  workspaceService: WorkspaceService,
) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function listWorkspaceAgents(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListAgentsData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!(await workspaceService.canAccess(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
    }

    // Fetch workspace owner to include their superagents
    const workspacesCol = db.collection('workspaces')
    const workspace = await workspacesCol.findOne({ workspaceId: data.workspaceId } as any)
    const workspaceOwnerId = (workspace as any)?.ownerId

    // Shared predicate with channel-creation authz (services/channel-authz.ts)
    const agentList = await agents
      .find(usableAgentFilter(ctx.userId, data.workspaceId, workspaceOwnerId) as Filter<Agent>)
      .toArray()

    const cores = await agentCores.find({}).toArray()
    const coreMap = new Map(cores.map((c) => [c.coreId, c]))

    return {
      workspaceId: data.workspaceId,
      agents: agentList.map((a) => {
        const core = coreMap.get(a.coreId)
        const avatarUrl = a.avatarUrl || core?.avatarUrl
        return {
          agentId: a.agentId,
          name: a.name,
          fullName: a.fullName,
          avatarUrl: buildAvatarUrl(avatarUrl),
          role: a.role,
          coreId: a.coreId,
        }
      }),
    }
  }
}
