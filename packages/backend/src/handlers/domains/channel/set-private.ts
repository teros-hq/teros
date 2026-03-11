/**
 * channel.set-private — Mark a channel as private
 * Private channels are hidden from lists/search and deleted on close.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'

interface SetChannelPrivateData {
  channelId: string
  isPrivate: boolean
}

export function createSetPrivateHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
) {
  return async function setChannelPrivate(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetChannelPrivateData

    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      throw new HandlerError('UNAUTHORIZED', 'Access denied')
    }

    await channelManager.setChannelPrivate(data.channelId, data.isPrivate)

    // Broadcast channel_status to channel subscribers
    const subscribers = sessionManager.getChannelSubscribers(data.channelId)
    const channelStatusMsg = JSON.stringify({
      type: 'channel_status',
      channelId: data.channelId,
      isPrivate: data.isPrivate,
    })
    for (const session of subscribers) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(channelStatusMsg)
      }
    }

    // If set to private, remove from conversation lists of all user sessions
    if (data.isPrivate) {
      const sessions = sessionManager.getUserSessions(ctx.userId)
      const listStatusMsg = JSON.stringify({
        type: 'channel_list_status',
        channelId: data.channelId,
        action: 'deleted',
        channel: {
          channelId: data.channelId,
          status: 'active',
          isPrivate: true,
        },
      })
      for (const session of sessions) {
        if (session.ws.readyState === session.ws.OPEN) {
          session.ws.send(listStatusMsg)
        }
      }
    }

    return { channelId: data.channelId, isPrivate: data.isPrivate }
  }
}
