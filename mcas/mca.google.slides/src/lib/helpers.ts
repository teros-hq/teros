import type { slides_v1 } from 'googleapis';

/**
 * Extract text content from a Google Slides slide
 */
export function extractTextFromSlide(slide: slides_v1.Schema$Page): string {
  const textParts: string[] = [];

  for (const element of slide.pageElements || []) {
    if (element.shape?.text) {
      const text = element.shape.text.textElements
        ?.map((el) => el.textRun?.content || '')
        .join('')
        .trim();

      if (text) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('\n');
}

/**
 * Process escape sequences in text.
 *
 * The tool execution pipeline may pass \n, \t, \r as literal two-character
 * sequences (backslash + letter) instead of actual control characters.
 * The Google Slides API expects real newline characters for line breaks,
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
