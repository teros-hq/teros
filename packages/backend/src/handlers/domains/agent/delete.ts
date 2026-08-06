/**
 * agent.delete — Delete an agent instance owned by the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Collection, Db } from 'mongodb'
import type { PubSubService } from '../../../services/pubsub-service'

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

    const existingAgent = await agents.findOne({ agentId, ownerId: ctx.userId })
    if (!existingAgent) {
      throw new HandlerError('AGENT_NOT_FOUND', `Agent '${agentId}' not found or access denied`)
    }

    const { workspaceId } = existingAgent

    await agents.deleteOne({ agentId, ownerId: ctx.userId })
    console.log(`[agent.delete] Deleted agent: ${agentId} for user ${ctx.userId}`)

    // Clean up scheduler tasks bound to this agent's channels (TER-650/G7).
    // Scheduler tasks are keyed by channel; deleting the agent leaves them
    // referencing a gone agent → the scheduler keeps firing them (failing
    // ownership) until the failure cap disables them. Remove them at the root.
    const agentChannels = await db
      .collection('channels')
      .find({ agentId }, { projection: { channelId: 1 } })
      .toArray()
    const channelIds = agentChannels.map((c) => c.channelId as string).filter(Boolean)
    if (channelIds.length > 0) {
      const [recurring, reminders] = await Promise.all([
        db.collection('scheduler_recurring_tasks').deleteMany({ channel_id: { $in: channelIds } }),
        db.collection('scheduler_reminders').deleteMany({ channel_id: { $in: channelIds } }),
      ])
      console.log(
        `[agent.delete] Cleaned scheduler tasks for ${channelIds.length} channels: ` +
          `${recurring.deletedCount} recurring, ${reminders.deletedCount} reminders`,
      )
    }

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
