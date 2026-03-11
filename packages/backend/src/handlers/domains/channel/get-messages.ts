/**
 * channel.get-messages — Retrieve paginated message history for a channel
 */

import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { MessageHandler } from '../../message-handler'

interface GetMessagesData {
  channelId: string
  limit?: number
  before?: string
}

export function createGetMessagesHandler(messageHandler: MessageHandler) {
  return async function getMessages(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetMessagesData
    const ws = (ctx as WsHandlerContext & { ws: WebSocket }).ws

    await messageHandler.handleGetMessages(ws, ctx.userId, {
      type: 'get_messages',
      channelId: data.channelId,
      limit: data.limit,
      before: data.before,
    })

    // handleGetMessages sends messages_history directly via ws.
    // Return empty object — the WsRouter will send a generic { type: 'response' } ack.
    return {}
  }
}
