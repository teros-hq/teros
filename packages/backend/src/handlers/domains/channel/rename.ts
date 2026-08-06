/**
 * channel.rename — Rename a channel
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'

interface RenameChannelData {
  channelId: string
  name: string
}

export function createRenameChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  pubSubService: PubSubService,
) {
  return async function renameChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RenameChannelData

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    await channelManager.renameChannel(data.channelId, data.name)

    // Re-fetch + enrich so the broadcast carries the full shape (agentName,
    // agentAvatarUrl, model). Otherwise NavBar consumers lose the agent
    // identity on update because the payload was a partial.
    const renamed = await channelManager.getChannel(data.channelId)
    const channelData = await channelManager.enrichChannel({
      channelId: renamed!.channelId,
      agentId: renamed!.agentId,
      title: renamed!.metadata?.name || data.name,
      status: renamed!.status,
      createdAt: renamed!.createdAt,
      updatedAt: renamed!.updatedAt,
      workspaceId: renamed!.workspaceId,
    })

    // Broadcast channel_list_status to all user sessions (for conversation list)
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const listStatusMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: data.channelId,
      action: 'updated',
      channel: channelData,
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(listStatusMsg)
      }
    }

    // Broadcast channel_status to channel subscribers (for tabs)
    pubSubService.broadcastToTopic(`channel:${data.channelId}`, {
      type: 'channel_status',
      channelId: data.channelId,
      title: data.name,
    })

    return { channelId: data.channelId, name: data.name }
  }
}
