/**
 * agent.set-providers — Set availableProviders for an agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'

interface SetProvidersData {
  agentId: string
  availableProviders: string[]
}

export function createSetProvidersHandler(db: Db) {
  return async function setProviders(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetProvidersData
    const { agentId, availableProviders } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }

    if (!Array.isArray(availableProviders)) {
      throw new HandlerError('INVALID_INPUT', 'availableProviders must be an array')
    }

    const agent = await db.collection('agents').findOne({ agentId })
    if (!agent) {
      throw new HandlerError('AGENT_NOT_FOUND', 'Agent not found')
    }

    if (agent.ownerId && agent.ownerId !== ctx.userId) {
      throw new HandlerError('PERMISSION_DENIED', 'You do not have permission to modify this agent')
    }

    await db.collection('agents').updateOne(
      { agentId },
      { $set: { availableProviders, updatedAt: new Date().toISOString() } },
    )

    console.log(`[agent.set-providers] Updated availableProviders for agent ${agentId}`)

    return { agentId, availableProviders }
  }
}
