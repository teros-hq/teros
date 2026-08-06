import type { docs_v1 } from 'googleapis';

/**
 * Extract text content from a Google Docs document
 */
export function extractTextFromDocument(doc: docs_v1.Schema$Document): string {
  const textParts: string[] = [];

  for (const content of doc.body?.content || []) {
    if (content.paragraph) {
      const text = content.paragraph.elements?.map((el) => el.textRun?.content || '').join('');

      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('');
}

/**
 * Process escape sequences in text.
 *
 * The tool execution pipeline may pass \n, \t, \r as literal two-character
 * sequences (backslash + letter) instead of actual control characters.
 * The Google Docs API expects real newline characters for line breaks,
 * so we convert any literal escape sequences to their actual characters.
 *
 * @fixme alice - 2026.07.12 : this is a workaround for a serialization issue
 * in the tool execution pipeline. The root cause is likely double-JSON-encoding
 * somewhere in the WebSocket transport layer. This helper should be removed
 * once the pipeline properly deserializes escape sequences.
 */
export function processEscapeSequences(text: string): string {
  if (!text) return text;
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r');
}
