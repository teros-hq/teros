/**
 * channel.typing-stop — Broadcast typing indicator (user stopped typing)
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { MessageHandler } from '../../message-handler'

interface TypingData {
  channelId: string
}

export function createTypingStopHandler(
  channelManager: ChannelManager,
  messageHandler: MessageHandler,
) {
  return async function typingStop(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as TypingData
    const ws = (ctx as WsHandlerContext & { ws: WebSocket }).ws

    await messageHandler.handleTypingIndicator(ws, ctx.userId, {
      type: 'typing_stop',
      channelId: data.channelId,
    })

    return { channelId: data.channelId }
  }
}
