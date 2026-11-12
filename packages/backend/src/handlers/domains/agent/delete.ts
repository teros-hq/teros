/**
 * agent.delete — Delete an agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import { DeletionService } from '../../../services/deletion-service'
import type { PubSubService } from '../../../services/pubsub-service'
import { canAccessAgent } from '../../../auth/workspace-access'

interface Agent {
  agentId: string
  ownerId: string
  workspaceId?: string
}

interface DeleteAgentData {
  agentId: string
}

export function createDeleteAgentHandler(db: Db, pubSubService?: PubSubService | null) {
  const agents: Collection<Agent> = db.collection('agents')

  return async function deleteAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteAgentData
    console.log(`[agent.delete] Deleting agent for user: ${ctx.userId}`, data)

    const { agentId } = data

    if (!agentId) {
      throw new HandlerError('INVALID_REQUEST', 'Missing required field: agentId')
    }

    // MUW-REQ-3: any active member of the agent's workspace can archive it;
    // global agents (superagents) only by their owner.
    const existingAgent = await agents.findOne({ agentId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found`)
    }
    if (!(await canAccessAgent(db, ctx.userId, agentId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this agent')
    }

    const { workspaceId } = existingAgent

    // Full cascade (INF-3): the agent's channels and their content, access
    // grants, skills, project relationships, subscriptions, Automate starters
    // that run as it or post to its channels (TER-650/G7), task assignments.
    const report = await new DeletionService(db).deleteAgent(agentId, ctx.userId)
    console.log(`[agent.delete] Deleted agent: ${agentId} for user ${ctx.userId}`, report)

    if (pubSubService) {
      const event = { type: 'agent.deleted', agentId, workspaceId }
      if (workspaceId) {
        await pubSubService.broadcastToWorkspace(workspaceId, event)
      } else {
        pubSubService.broadcastToUser(ctx.userId, event)
      }
    }

    return { agentId }
  }
}
