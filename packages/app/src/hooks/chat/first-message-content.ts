/**
 * Builds the `content` for `channel.create-with-message` — the first message of a
 * brand-new chat.
 *
 * Extracted from `useChatInput` so the priority logic is unit-testable without React
 * (same rationale as `pending-extraction`). The original inline version only handled
 * audio and text, silently dropping image/file attachments — so starting a chat with
 * an image left the agent with no image to see. This builder includes the file.
 *
 * Priority: audio > file(s) > text. A single file carries the trailing text as
 * `caption` so the agent receives image + question in one turn. With multiple files
 * only the first is returned here; the caller sends the rest as follow-up messages.
 */

import type { MessageContent } from '../../services/ChannelApi'

export interface UploadedFileLite {
  url: string
  originalName: string
  mimeType: string
  size: number
}

export interface FirstMessageAudio {
  data: string
  mimeType?: string
  duration?: number
}

export function buildFirstMessageContent(opts: {
  audio?: FirstMessageAudio
  files?: UploadedFileLite[]
  text: string
}): MessageContent {
  const { audio, files, text } = opts

  if (audio) {
    return {
      type: 'voice',
      data: audio.data,
      mimeType: audio.mimeType,
      duration: audio.duration,
    }
  }

  if (files && files.length > 0) {
    const first = files[0]
    return {
      type: 'file',
      url: first.url,
      filename: first.originalName,
      mimeType: first.mimeType,
      size: first.size,
      // Only merge the caption when this is the sole file; with multiple files the
      // text is sent as a separate trailing message by the caller.
      ...(files.length === 1 && text ? { caption: text } : {}),
    }
  }

  return { type: 'text', text }
}
