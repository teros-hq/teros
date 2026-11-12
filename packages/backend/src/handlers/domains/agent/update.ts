/**
 * agent.update — Update an existing agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { isValidWorkspaceColor, isValidWorkspaceIcon } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import { assertOwnProviders } from './provider-ownership'
import { canAccessAgent } from '../../../auth/workspace-access'
import { broadcastAgentUpdated, buildAgentUpdatedPayload } from '../../../lib/agent-payload'
import type { PubSubService } from '../../../services/pubsub-service'

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
  selectedProviderId?: string | null
  selectedModelId?: string | null
  appearance?: { color?: string; icon?: string }
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
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
  selectedProviderId?: string | null
  selectedModelId?: string | null
  appearance?: { color?: string; icon?: string }
  /**
   * System-capability toggles (v1.4.4): mcaIds of system MCAs to force OFF
   * (denylist for default-ON capabilities) / force ON (allowlist for
   * default-OFF power capabilities). Toggling triggers re-provisioning via
   * ensureProvisionedApps on the next app resolution (self-healing both ways).
   */
  disabledSystemApps?: string[]
  enabledSystemApps?: string[]
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
      selectedProviderId,
      selectedModelId,
      appearance,
      disabledSystemApps,
      enabledSystemApps,
    } = data

    if (!agentId) {
      throw new HandlerError('INVALID_REQUEST', 'Missing required field: agentId')
    }

    // MUW-REQ-3: workspace agents belong to the team — any active member of
    // the workspace can edit them. Global agents (superagents) stay private
    // to their owner. canAccessAgent encodes exactly that.
    const existingAgent = await agents.findOne({ agentId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found`)
    }
    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this agent')
    }

    // Only the caller's own providers (MOD-8). The availableProviders list is
    // GONE (2026-10-21): a pin is a single (provider, model) pair — the list is
    // neither an input nor an anchor of resolution anymore.
    await assertOwnProviders(db, ctx.userId, [selectedProviderId])

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

    // System-capability toggles (v1.4.4). Both are full-list replacements
    // (PUT semantics, same as the other fields): the client sends the
    // complete desired state. mcaIds are validated against the catalog so a
    // typo can't silently no-op the provisioning reconciliation.
    if (disabledSystemApps !== undefined || enabledSystemApps !== undefined) {
      const mcaCatalog = db.collection('mca_catalog')
      const requested = [...(disabledSystemApps ?? []), ...(enabledSystemApps ?? [])]
      if (requested.length > 0) {
        const known = await mcaCatalog
          .find({ mcaId: { $in: requested }, 'availability.system': true, status: 'active' })
          .project({ mcaId: 1 })
          .toArray()
        const knownIds = new Set(known.map((k) => k.mcaId))
        const unknown = requested.filter((id) => !knownIds.has(id))
        if (unknown.length > 0) {
          throw new HandlerError(
            'INVALID_REQUEST',
            `Unknown or non-system capability ids: ${unknown.join(', ')}`,
          )
        }
      }
      if (disabledSystemApps !== undefined) updateFields.disabledSystemApps = disabledSystemApps
      if (enabledSystemApps !== undefined) updateFields.enabledSystemApps = enabledSystemApps
    }

    await agents.updateOne({ agentId }, { $set: updateFields })

    const updatedAgent = await agents.findOne({ agentId })
    if (!updatedAgent) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to retrieve updated agent')
    }

    console.log(`[agent.update] Updated agent: ${agentId} for user ${ctx.userId}`)

    const core = await agentCores.findOne({ coreId: updatedAgent.coreId })

    // Shared payload/broadcast helper — same shape + scope as the REST avatar
    // upload path (http-upload-handler.ts), so the two cannot drift (TER-644).
    const agentPayload = buildAgentUpdatedPayload(updatedAgent, core?.avatarUrl)

    // Non-fatal: the update is already persisted, so a broadcast failure must not
    // fail the handler — same "persisted mutation, broadcast is best-effort"
    // pattern as the HTTP paths (http-upload-handler / mca-resources-handlers) (TER-644).
    if (pubSubService) {
      try {
        await broadcastAgentUpdated(pubSubService, ctx.userId, agentPayload)
      } catch (err) {
        console.warn('[agent.update] agent.updated broadcast failed', err)
      }
    }

    return { agent: agentPayload }
  }
}
