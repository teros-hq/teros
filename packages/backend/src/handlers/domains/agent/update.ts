/**
 * agent.update — Update an existing agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { isValidWorkspaceColor, isValidWorkspaceIcon } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import { buildAvatarUrl } from '../../../lib/avatar-url'
import type { PubSubService } from '../../../services/pubsub-service'
import { BillingGateService } from '../../../services/billing-gate.js'

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
  appearance?: { color?: string; icon?: string }
}

export function createUpdateAgentHandler(db: Db, pubSubService?: PubSubService | null) {
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
      appearance,
    } = data

    if (!agentId) {
      throw new HandlerError('INVALID_REQUEST', 'Missing required field: agentId')
    }

    const existingAgent = await agents.findOne({ agentId, ownerId: ctx.userId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`)
    }

    // Billing gate: block adding 'teros' provider for users without terosModel feature
    if (availableProviders !== undefined) {
      const currentProviders = existingAgent.availableProviders ?? []
      const isAddingTeros =
        availableProviders.includes('teros') && !currentProviders.includes('teros')
      if (isAddingTeros) {
        const billingGate = new BillingGateService(db)
        await billingGate.assertTerosModelAllowed(ctx.userId)
      }
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
    if (appearance !== undefined) {
      if (appearance.color && !isValidWorkspaceColor(appearance.color)) {
        throw new HandlerError('INVALID_REQUEST', `Invalid agent color: ${appearance.color}`)
      }
      if (appearance.icon && !isValidWorkspaceIcon(appearance.icon)) {
        throw new HandlerError('INVALID_REQUEST', `Invalid agent icon: ${appearance.icon}`)
      }
      updateFields.appearance = appearance
    }

    await agents.updateOne({ agentId, ownerId: ctx.userId }, { $set: updateFields })

    const updatedAgent = await agents.findOne({ agentId })
    if (!updatedAgent) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to retrieve updated agent')
    }

    console.log(`[agent.update] Updated agent: ${agentId} for user ${ctx.userId}`)

    const core = await agentCores.findOne({ coreId: updatedAgent.coreId })
    const finalAvatarUrl = updatedAgent.avatarUrl || core?.avatarUrl

    const agentPayload = {
      agentId: updatedAgent.agentId,
      name: updatedAgent.name,
      fullName: updatedAgent.fullName,
      role: updatedAgent.role,
      intro: updatedAgent.intro,
      avatarUrl: buildAvatarUrl(finalAvatarUrl),
      coreId: updatedAgent.coreId,
      workspaceId: updatedAgent.workspaceId,
      maxSteps: updatedAgent.maxSteps,
      context: updatedAgent.context,
      appearance: updatedAgent.appearance,
    }

    if (pubSubService) {
      const event = { type: 'agent.updated', agent: agentPayload }
      if (updatedAgent.workspaceId) {
        await pubSubService.broadcastToWorkspace(updatedAgent.workspaceId, event)
      } else {
        pubSubService.broadcastToUser(ctx.userId, event)
      }
    }

    return { agent: agentPayload }
  }
}
