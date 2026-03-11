/**
 * channel.create — Create a new channel for the user
 */

import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'

interface CreateChannelData {
  agentId: string
  metadata?: Record<string, any>
  workspaceId?: string
}

export function createCreateChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
) {
  return async function createChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateChannelData

    const channel = await channelManager.createChannel(
      ctx.userId,
      data.agentId,
      data.metadata,
      { workspaceId: data.workspaceId },
    )

    const baseChannelData = {
      channelId: channel.channelId,
      agentId: channel.agentId,
      title: channel.metadata?.name || 'Nuevo chat',
      status: channel.status,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      workspaceId: channel.workspaceId,
    }

    // Enrich with agent info and model
    const channelData = await channelManager.enrichChannel(baseChannelData)

    // Broadcast to all user sessions so conversation lists update in real-time
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const broadcastMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: channel.channelId,
      action: 'created',
      channel: channelData,
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(broadcastMsg)
      }
    }

    return {
      channelId: channel.channelId,
      agentId: channel.agentId,
      channel: channelData,
    }
  }
}
