/**
 * agent.create — Create a new agent instance for the user or a workspace
 */

import { generateAgentId } from '@teros/core'
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
  context?: string
  createdAt?: string
  updatedAt?: string
}

interface AgentCore {
  coreId: string
  avatarUrl?: string
  personality: string[]
  capabilities: string[]
}

interface CreateAgentData {
  coreId: string
  name: string
  fullName: string
  role: string
  intro: string
  avatarUrl?: string
  workspaceId?: string
  context?: string
}

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
}

export function createCreateAgentHandler(
  db: Db,
  workspaceService?: WorkspaceService | null,
) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function createAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateAgentData
    console.log(`[agent.create] Creating agent for user: ${ctx.userId}`, data)

    const { coreId, name, fullName, role, intro, avatarUrl, workspaceId, context } = data

    if (!coreId || !name || !fullName || !role || !intro) {
      throw new HandlerError(
        'INVALID_REQUEST',
        'Missing required fields: coreId, name, fullName, role, intro',
      )
    }

    if (workspaceId) {
      if (!workspaceService) {
        throw new HandlerError('WORKSPACE_NOT_CONFIGURED', 'Workspace service not available')
      }
      if (!(await workspaceService.canWrite(workspaceId, ctx.userId))) {
        throw new HandlerError('ACCESS_DENIED', 'You do not have write access to this workspace')
      }
      const workspace = await workspaceService.getWorkspace(workspaceId)
      if (!workspace) {
        throw new HandlerError('WORKSPACE_NOT_FOUND', `Workspace '${workspaceId}' not found`)
      }
    }

    const core = await agentCores.findOne({ coreId })
    if (!core) {
      throw new HandlerError('CORE_NOT_FOUND', `Agent core '${coreId}' not found`)
    }

    const agentId = generateAgentId()
    const now = new Date().toISOString()

    const newAgent: Agent = {
      agentId,
      coreId,
      ownerId: ctx.userId,
      workspaceId,
      name,
      fullName,
      role,
      intro,
      avatarUrl: avatarUrl || core.avatarUrl,
      context,
      createdAt: now,
      updatedAt: now,
    }

    await agents.insertOne(newAgent)
    console.log(
      `[agent.create] Created agent: ${agentId} for user ${ctx.userId}${workspaceId ? ` in workspace ${workspaceId}` : ' (global)'}`,
    )

    return {
      agent: {
        agentId: newAgent.agentId,
        name: newAgent.name,
        fullName: newAgent.fullName,
        role: newAgent.role,
        intro: newAgent.intro,
        avatarUrl: buildAvatarUrl(newAgent.avatarUrl),
        coreId: newAgent.coreId,
        workspaceId: newAgent.workspaceId,
      },
    }
  }
}
