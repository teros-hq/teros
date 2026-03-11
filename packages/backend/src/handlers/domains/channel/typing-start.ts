/**
 * channel.typing-start — Broadcast typing indicator (user started typing)
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { MessageHandler } from '../../message-handler'

interface TypingData {
  channelId: string
}

export function createTypingStartHandler(
  channelManager: ChannelManager,
  messageHandler: MessageHandler,
) {
  return async function typingStart(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as TypingData
    const ws = (ctx as WsHandlerContext & { ws: WebSocket }).ws

    await messageHandler.handleTypingIndicator(ws, ctx.userId, {
      type: 'typing_start',
      channelId: data.channelId,
    })

    return { channelId: data.channelId }
  }
}
