/**
 * agent.delete — Delete an agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'

interface Agent {
  agentId: string
  ownerId: string
}

interface DeleteAgentData {
  agentId: string
}

export function createDeleteAgentHandler(db: Db) {
  const agents: Collection<Agent> = db.collection('agents')

  return async function deleteAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteAgentData
    console.log(`[agent.delete] Deleting agent for user: ${ctx.userId}`, data)

    const { agentId } = data

    if (!agentId) {
      throw new HandlerError('INVALID_REQUEST', 'Missing required field: agentId')
    }

    const existingAgent = await agents.findOne({ agentId, ownerId: ctx.userId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`)
    }

    await agents.deleteOne({ agentId, ownerId: ctx.userId })
    console.log(`[agent.delete] Deleted agent: ${agentId} for user ${ctx.userId}`)

    return { agentId }
  }
}
