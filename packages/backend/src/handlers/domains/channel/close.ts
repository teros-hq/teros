/**
 * channel.close — Close a channel (soft-delete from conversation list)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'

interface CloseChannelData {
  channelId: string
}

export function createCloseChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
) {
  return async function closeChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CloseChannelData

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    await channelManager.closeChannel(data.channelId)

    // Broadcast to all user sessions
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const broadcastMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: data.channelId,
      action: 'deleted',
      channel: {
        channelId: data.channelId,
        status: 'closed',
      },
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(broadcastMsg)
      }
    }

    return { channelId: data.channelId, status: 'closed' }
  }
}
