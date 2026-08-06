/**
 * Boundary validators for Canva tool inputs.
 *
 * JSON Schema covers types and presence; these helpers cover what it cannot:
 * URL protocol whitelists, non-empty strings, mutex constraints. Errors include
 * the param name and an actionable message so the LLM (or user) can fix the
 * request without inspecting the upstream Canva error.
 */

const URL_PROTOCOL_WHITELIST = ['http:', 'https:'];

export function validateExternalUrl(value: string, paramName: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${paramName} must be a non-empty URL string.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${paramName} must be a valid URL (received: ${value}).`);
  }
  if (!URL_PROTOCOL_WHITELIST.includes(parsed.protocol)) {
    throw new Error(
      `${paramName} must use http:// or https:// (received protocol: ${parsed.protocol}).`,
    );
  }
}

export function validateNonEmpty(value: unknown, paramName: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${paramName} must be a non-empty string.`);
  }
}

export function validatePages(pages: unknown, paramName = 'pages'): void {
  if (!Array.isArray(pages)) {
    throw new Error(`${paramName} must be an array of positive integers.`);
  }
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1) {
      throw new Error(`${paramName}[${i}] must be a positive integer (1-indexed); received ${p}.`);
    }
  }
}
