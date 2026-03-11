/**
 * agent.list — List agent instances for the current user or a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import { config } from '../../../config'
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
}

interface AgentCore {
  coreId: string
  avatarUrl?: string
}

interface ListAgentData {
  workspaceId?: string
}

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
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

    const query: Record<string, unknown> = {}
    if (workspaceId) {
      query.workspaceId = workspaceId
    } else {
      query.ownerId = ctx.userId
      query.workspaceId = null
    }

    const agentList = await agents.find(query).toArray()
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
        }
      }),
    }
  }
}
