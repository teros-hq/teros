/**
 * Message redaction helpers shared by the backend (serving) and the app
 * (live `message_redacted` pushes).
 *
 * @spec MUW-REQ-9
 */

/**
 * Replace every Unicode letter (\p{L}) and number (\p{N}) with the middle dot
 * (·, U+00B7). Markdown syntax, whitespace and punctuation are preserved so
 * the message structure stays visible. Deterministic and lossy: the result
 * carries zero recoverable information.
 */
export function obfuscateText(text: string): string {
  return text.replace(/[\p{L}\p{N}]/gu, '·')
}
