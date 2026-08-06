/**
 * mca.teros.http — shared data helpers and types.
 *
 * Per the renderer standard (TER-281 §1), this module exports ZERO React
 * components. Only the output type and pure data helpers that feed the global
 * primitives. The sub-renderers (`RequestRenderer`, `HealthCheckRenderer`)
 * compose `primitives/*` directly.
 */

import { parseOutput } from '../../primitives';

// ============================================================================
// Output shape of the `http-request` tool — mirrors the backend handler in
// `mcas/mca.teros.http/src/tools/http-request.ts`. Credentials inside
// `headers` / `query` / `url` already arrive masked as "***" from the backend.
// ============================================================================

export interface HttpRequestOutput {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    query: Record<string, string>;
    hasBody: boolean;
  };
  response: {
    status: number;
    statusText: string;
    ok: boolean;
    contentType: string;
    headers: Record<string, string>;
    /** Parsed object/array when the response was JSON; raw string otherwise. */
    body: unknown;
    sizeBytes: number;
    truncated: boolean;
  };
}

/**
 * Parse + shape-guard the tool output. `parseOutput` returns `T | string |
 * null`; we only accept a real object carrying `request` + `response`, so a
 * non-JSON string or a partial payload yields `null` (header-only fallback).
 */
export function parseHttpOutput(output?: string): HttpRequestOutput | null {
  if (!output) return null;
  const parsed = parseOutput<HttpRequestOutput>(output);
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'request' in parsed &&
    'response' in parsed
  ) {
    return parsed as HttpRequestOutput;
  }
  return null;
}

/**
 * Host for the header description. The URL may carry `{{SECRET}}` placeholders
 * in the path/query and still parse; if it does not parse at all, fall back to
 * the raw string ("si parsea mal, usa la url tal cual").
 */
export function getHostFromUrl(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** Human-readable byte size for the meta grid. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Map a response content-type to a `CodeBlock` language hint. */
function languageForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('yaml') || ct.includes('yml')) return 'yaml';
  if (ct.includes('csv')) return 'plaintext';
  return 'plaintext';
}

/**
 * Turn a response body into `{ code, language }` for `<CodeBlock>`. Parsed
 * JSON (object/array) is pretty-printed; strings are shown verbatim with a
 * language inferred from the content-type. Returns `null` when there is
 * nothing worth showing (empty/whitespace string, `null`/`undefined` body) so
 * the caller can omit the block entirely (e.g. a 204 No Content).
 */
export function bodyToCode(
  body: unknown,
  contentType: string,
): { code: string; language: string } | null {
  if (body == null) return null;
  if (typeof body === 'string') {
    if (body.trim() === '') return null;
    return { code: body, language: languageForContentType(contentType) };
  }
  try {
    return { code: JSON.stringify(body, null, 2), language: 'json' };
  } catch {
    return { code: String(body), language: 'plaintext' };
  }
}

/**
 * Split a `[CODE] message` error into a humanized title + message. The backend
 * prefixes every tool error with a bracketed code ([TIMEOUT],
 * [BLOCKED_PRIVATE_IP], [MISSING_SECRET], [BAD_URL], …) — surfacing it as the
 * `ErrorBlock` title lets the user (and the agent) distinguish a transient
 * timeout from an SSRF block at a glance. Falls back to the raw error.
 */
export function parseErrorCode(error: string): { title?: string; message: string } {
  const match = error.match(/^\[([A-Z0-9_]+)\]\s*([\s\S]*)$/);
  if (match) {
    return { title: match[1].replace(/_/g, ' '), message: match[2] || error };
  }
  return { message: error };
}
