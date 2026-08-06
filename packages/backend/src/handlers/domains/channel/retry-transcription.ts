/**
 * channel.retry-transcription — Retry transcription for a voice message that failed
 */

import type { WsHandlerContext } from '@teros/shared'
import type { MessageHandler } from '../../message-handler'

interface RetryTranscriptionData {
  channelId: string
  messageId: string
}

export function createRetryTranscriptionHandler(messageHandler: MessageHandler) {
  return async function retryTranscription(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RetryTranscriptionData
    await messageHandler.retryTranscription(ctx.userId, data.channelId, data.messageId)
    return {}
  }
}
