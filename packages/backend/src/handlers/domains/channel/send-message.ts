/**
 * channel.send-message — Send a message to a channel and trigger agent response
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { MessageHandler } from '../../message-handler'

interface SendMessageData {
  channelId: string
  content: any
  requestId?: string
  requireAck?: boolean
}

export function createSendMessageHandler(messageHandler: MessageHandler) {
  return async function sendMessage(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SendMessageData
    const ws = (ctx as WsHandlerContext & { ws: WebSocket }).ws

    await messageHandler.handleSendMessage(ws, ctx.userId, {
      type: 'send_message',
      channelId: data.channelId,
      content: data.content,
    })

    // handleSendMessage sends its own response (message_sent) directly via ws.
    // Return empty object — the WsRouter will send a generic { type: 'response' } ack.
    return {}
  }
}
