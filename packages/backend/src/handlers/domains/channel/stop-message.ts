import type { WebSocket } from 'ws'
import type { WsHandlerContext } from '@teros/shared'
import type { MessageHandler } from '../../message-handler'

interface StopMessageData {
  channelId: string
  kind?: 'soft' | 'hard' | 'queue_only'
}

export function createStopMessageHandler(messageHandler: MessageHandler) {
  return async function stopMessage(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as StopMessageData
    const ws = (ctx as WsHandlerContext & { ws: WebSocket }).ws

    await messageHandler.handleStopMessage(ws, ctx.userId, {
      type: 'stop_message',
      channelId: data.channelId,
      kind: data.kind ?? 'soft',
    })

    return {}
  }
}
