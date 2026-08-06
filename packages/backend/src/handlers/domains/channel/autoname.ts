/**
 * channel.autoname — Auto-generate a channel name via LLM based on conversation content
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'

interface AutonameChannelData {
  channelId: string
}

export function createAutonameChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  pubSubService: PubSubService,
) {
  return async function autonameChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AutonameChannelData

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    const name = await channelManager.autonameChannel(data.channelId)
    if (!name) {
      throw new HandlerError('AUTONAME_FAILED', 'Could not generate name for channel')
    }

    // Re-fetch + enrich so the broadcast carries the full shape and NavBar
    // consumers don't lose agentName / agentAvatarUrl on the title update.
    const renamed = await channelManager.getChannel(data.channelId)
    const channelData = await channelManager.enrichChannel({
      channelId: renamed!.channelId,
      agentId: renamed!.agentId,
      title: renamed!.metadata?.name || name,
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
      title: name,
    })

    return { channelId: data.channelId, name }
  }
}
