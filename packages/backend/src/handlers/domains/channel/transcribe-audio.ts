/**
 * channel.transcribe-audio — Transcribe audio data and return text (no message, no agent)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { MessageHandler } from '../../message-handler'

interface TranscribeAudioData {
  data: string
  mimeType?: string
}

export function createTranscribeAudioHandler(messageHandler: MessageHandler) {
  return async function transcribeAudio(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as TranscribeAudioData
    const result = await messageHandler.transcribeAudio(ctx.userId, data.data, data.mimeType)
    return result
  }
}
