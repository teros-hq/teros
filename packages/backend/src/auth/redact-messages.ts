/**
 * Redaction enforcement utility — the backend security boundary for message content.
 *
 * When serving messages to a viewer who is NOT the channel creator, any message
 * with `redacted: true` MUST have its content obfuscated. The real content is never
 * sent over the wire to non-owners — instead, all alphanumeric characters are replaced
 * with the middle dot character (·, U+00B7), preserving Markdown structure so the
 * message's shape (headers, lists, code blocks) remains visible while the text is
 * completely unrecoverable.
 *
 * The channel creator always receives the full, unredacted content (for click-to-reveal UI).
 *
 * Spec: REQ-4, REQ-5, NFR-2 — multi-user-workspaces.md
 */

import type { Message } from '@teros/shared'
import { obfuscateText } from '@teros/shared'

/**
 * Placeholder shape that accompanies redacted message content for non-owners.
 * Contains metadata only — never the original text, tool results, or file URLs.
 */
export interface RedactedPlaceholder {
  type: 'redacted'
  reason: 'protected_by_owner'
  originalAuthor: string
  originalTimestamp: string
}

/**
 * A message after redaction enforcement. For non-owners viewing a redacted
 * message, `content` contains obfuscated text (all alphanumeric chars replaced
 * with `·`) and `redactedPlaceholder` carries metadata.
 */
export type RedactedMessage = Omit<Message, 'content'> & {
  content: Message['content'] | null
  redactedPlaceholder?: RedactedPlaceholder
}

/**
 * Replace every Unicode letter (\p{L}) and number (\p{N}) with the middle dot (·, U+00B7).
 * This covers all scripts: Latin (including accented), CJK, Cyrillic, Arabic, Hebrew, etc.
 * All other characters — Markdown syntax, whitespace, punctuation, special chars —
 * are preserved so the message structure remains visible.
 *
 * The result contains zero recoverable information: it is a deterministic,
 * lossy transformation. The same input always produces the same output.
 */
export { obfuscateText }

/**
 * Apply redaction enforcement to a list of messages for a specific viewer.
 *
 * @param messages  - Raw messages from the database
 * @param isOwner   - Whether the viewer is the channel creator (owner)
 * @returns Messages with redacted content obfuscated for non-owners.
 *          Owners receive all messages unmodified.
 */
export function redactMessagesForViewer(
  messages: Message[],
  isOwner: boolean,
): RedactedMessage[] {
  // Owner sees everything — no filtering
  if (isOwner) return messages as RedactedMessage[]

  // Non-owner: obfuscate redacted messages
  return messages.map((msg) => {
    if (!msg.redacted) return msg as RedactedMessage

    // Obfuscate the text content: replace all alphanumeric chars with ·
    // This preserves Markdown structure while making the text unrecoverable.
    const originalText =
      msg.content?.type === 'text' ? msg.content.text : ''
    const obfuscatedText = obfuscateText(originalText)

    return {
      ...msg,
      content: { type: 'text' as const, text: obfuscatedText },
      redacted: true,
      redactedPlaceholder: {
        type: 'redacted',
        reason: 'protected_by_owner',
        originalAuthor: msg.role,
        originalTimestamp: msg.timestamp,
      },
    } as RedactedMessage
  })
}

/**
 * Apply redaction enforcement to a single message for a specific viewer.
 *
 * @param message   - Raw message from the database
 * @param isOwner   - Whether the viewer is the channel creator (owner)
 * @returns The message with redacted content replaced by placeholder for non-owners.
 */
export function redactMessageForViewer(
  message: Message,
  isOwner: boolean,
): RedactedMessage {
  return redactMessagesForViewer([message], isOwner)[0]
}
