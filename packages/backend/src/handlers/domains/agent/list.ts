/**
 * agent.list — List agent instances for the current user or a workspace
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
  intro: string
  avatarUrl?: string
  maxSteps?: number
  context?: string
  availableProviders?: string[]
  selectedProviderId?: string | null
  selectedModelId?: string | null
  appearance?: { color?: string; icon?: string }
}

interface AgentCore {
  coreId: string
  avatarUrl?: string
}

interface ListAgentData {
  workspaceId?: string
}

export function createListAgentsHandler(
  db: Db,
  workspaceService?: WorkspaceService | null,
) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function listAgents(ctx: WsHandlerContext, rawData: unknown) {
    const data = (rawData ?? {}) as ListAgentData
    const { workspaceId } = data

    if (workspaceId) {
      if (!workspaceService) {
        throw new HandlerError('WORKSPACE_NOT_CONFIGURED', 'Workspace service not available')
      }
      if (!(await workspaceService.canAccess(workspaceId, ctx.userId))) {
        throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
      }
      console.log(`[agent.list] Listing agents for workspace: ${workspaceId}`)
    } else {
      console.log(`[agent.list] Listing global agents for user: ${ctx.userId}`)
    }

    let agentList: Agent[]
    if (workspaceId) {
      // Fetch workspace owner to also include their superagents
      const workspacesCol = db.collection('workspaces')
      const workspace = await workspacesCol.findOne({ workspaceId } as any)
      const workspaceOwnerId = (workspace as any)?.ownerId
      console.log(`[agent.list] ctx.userId=${ctx.userId}, workspaceOwnerId=${workspaceOwnerId}`)

      // Return workspace agents + the caller's / workspace owner's superagents.
      // Shared predicate with channel-creation authz (services/channel-authz.ts)
      // so "agents you can list" and "agents you can start a channel with" can
      // never drift apart — a drift would silently re-open the SEC-2 A2 hole.
      agentList = await agents
        .find(usableAgentFilter(ctx.userId, workspaceId, workspaceOwnerId) as Filter<Agent>)
        .toArray()
    } else {
      // No workspaceId: return only superagents (global agents)
      agentList = await agents.find({ ownerId: ctx.userId, workspaceId: { $in: [null, undefined] } } as any).toArray()
    }
    console.log(`[agent.list] Found ${agentList.length} agents`)

    const cores = await agentCores.find({}).toArray()
    const coreMap = new Map(cores.map((c) => [c.coreId, c]))

    return {
      workspaceId,
      agents: agentList.map((a: any) => {
        const core = coreMap.get(a.coreId)
        const avatarUrl = a.avatarUrl || core?.avatarUrl
        return {
          agentId: a.agentId,
          name: a.name,
          fullName: a.fullName,
          role: a.role,
          intro: a.intro,
          context: a.context || '',
          maxSteps: a.maxSteps,
          avatarUrl: buildAvatarUrl(avatarUrl),
          coreId: a.coreId,
          workspaceId: a.workspaceId,
          availableProviders: a.availableProviders || [],
          selectedProviderId: a.selectedProviderId || null,
          selectedModelId: a.selectedModelId || null,
          appearance: a.appearance,
        }
      }),
    }
  }
}
