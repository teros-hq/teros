/**
 * channel.subscribe — Subscribe the current session to a channel's real-time events
 *
 * Also restores any pending permission requests so the client can re-display them.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { MessageHandler } from '../../message-handler'

interface SubscribeChannelData {
  channelId: string
}

export function createSubscribeChannelHandler(
  channelManager: ChannelManager,
  sessionManager: SessionManager,
  messageHandler: MessageHandler,
) {
  return async function subscribeChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeChannelData

    console.log(
      `📺 [channel.subscribe] session=${ctx.sessionId}, user=${ctx.userId}, channel=${data.channelId}`,
    )

    const canAccess = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccess) {
      console.warn(
        `⚠️ [channel.subscribe] Denied: user ${ctx.userId} cannot access channel ${data.channelId}`,
      )
      throw new HandlerError('UNAUTHORIZED', 'Access denied to channel')
    }

    sessionManager.subscribeToChannel(ctx.sessionId, data.channelId)
    console.log(
      `✅ [channel.subscribe] session=${ctx.sessionId} subscribed to channel=${data.channelId}`,
    )

    // Restore any pending permission requests for this channel
    await messageHandler.restorePendingPermissions(data.channelId)

    return { channelId: data.channelId }
  }
}
