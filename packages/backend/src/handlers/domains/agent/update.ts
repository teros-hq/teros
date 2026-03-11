/**
 * agent.update — Update an existing agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import { config } from '../../../config'

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
  updatedAt?: string
}

interface AgentCore {
  coreId: string
  avatarUrl?: string
}

interface UpdateAgentData {
  agentId: string
  name?: string
  fullName?: string
  role?: string
  intro?: string
  avatarUrl?: string
  maxSteps?: number
  context?: string
  availableProviders?: string[]
  selectedProviderId?: string | null
  selectedModelId?: string | null
}

function buildAvatarUrl(avatarFilename?: string): string | undefined {
  if (!avatarFilename) return undefined
  return `${config.static.baseUrl}/${avatarFilename}`
}

export function createUpdateAgentHandler(db: Db) {
  const agents: Collection<Agent> = db.collection('agents')
  const agentCores: Collection<AgentCore> = db.collection('agent_cores')

  return async function updateAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateAgentData
    console.log(`[agent.update] Updating agent for user: ${ctx.userId}`, data)

    const {
      agentId,
      name,
      fullName,
      role,
      intro,
      avatarUrl,
      maxSteps,
      context,
      availableProviders,
      selectedProviderId,
      selectedModelId,
    } = data

    if (!agentId) {
      throw new HandlerError('INVALID_REQUEST', 'Missing required field: agentId')
    }

    const existingAgent = await agents.findOne({ agentId, ownerId: ctx.userId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`)
    }

    const updateFields: Partial<Agent> = {
      updatedAt: new Date().toISOString(),
    }

    if (name !== undefined) updateFields.name = name
    if (fullName !== undefined) updateFields.fullName = fullName
    if (role !== undefined) updateFields.role = role
    if (intro !== undefined) updateFields.intro = intro
    if (avatarUrl !== undefined) updateFields.avatarUrl = avatarUrl
    if (maxSteps !== undefined) updateFields.maxSteps = maxSteps
    if (context !== undefined) updateFields.context = context
    if (availableProviders !== undefined) updateFields.availableProviders = availableProviders
    if (selectedProviderId !== undefined) updateFields.selectedProviderId = selectedProviderId
    if (selectedModelId !== undefined) updateFields.selectedModelId = selectedModelId

    await agents.updateOne({ agentId, ownerId: ctx.userId }, { $set: updateFields })

    const updatedAgent = await agents.findOne({ agentId })
    if (!updatedAgent) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to retrieve updated agent')
    }

    console.log(`[agent.update] Updated agent: ${agentId} for user ${ctx.userId}`)

    const core = await agentCores.findOne({ coreId: updatedAgent.coreId })
    const finalAvatarUrl = updatedAgent.avatarUrl || core?.avatarUrl

    return {
      agent: {
        agentId: updatedAgent.agentId,
        name: updatedAgent.name,
        fullName: updatedAgent.fullName,
        role: updatedAgent.role,
        intro: updatedAgent.intro,
        avatarUrl: buildAvatarUrl(finalAvatarUrl),
        coreId: updatedAgent.coreId,
        maxSteps: updatedAgent.maxSteps,
        context: updatedAgent.context,
      },
    }
  }
}
