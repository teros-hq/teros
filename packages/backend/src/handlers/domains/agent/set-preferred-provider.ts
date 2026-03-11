/**
 * agent.set-preferred-provider — Set preferredProviderId for an agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'

interface SetPreferredProviderData {
  agentId: string
  providerId: string | null
}

export function createSetPreferredProviderHandler(db: Db) {
  return async function setPreferredProvider(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetPreferredProviderData
    const { agentId, providerId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }

    const agent = await db.collection('agents').findOne({ agentId })
    if (!agent) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    if (agent.ownerId && agent.ownerId !== ctx.userId) {
      throw new HandlerError('PERMISSION_DENIED', 'You do not have permission to modify this agent')
    }

    if (providerId) {
      const available: string[] = agent.availableProviders ?? []
      if (!available.includes(providerId)) {
        throw new HandlerError(
          'PROVIDER_NOT_AVAILABLE',
          'Provider must be in availableProviders before setting as preferred',
        )
      }
    }

    await db.collection('agents').updateOne(
      { agentId },
      { $set: { preferredProviderId: providerId, updatedAt: new Date().toISOString() } },
    )

    console.log(`[agent.set-preferred-provider] Updated preferredProviderId for agent ${agentId} to ${providerId}`)

    return { agentId, preferredProviderId: providerId }
  }
}
