/**
 * Pure helpers for mca.teros.http — secret substitution and credential masking.
 * Dependency-free on purpose, so they can be unit-tested without the MCA SDK or
 * a network. The handler in ../tools/http-request.ts composes these.
 */

/** {{SECRET_NAME}} — a reference to a stored user secret. Global (stateful). */
export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Non-global twin for stateless `.test()` (a global RE keeps `lastIndex`). */
const HAS_PLACEHOLDER_RE = /\{\{\s*[A-Za-z0-9_]+\s*\}\}/;

/** Any `{{ ... }}` pair. Used to detect a LEFTOVER reference after the valid ones
 *  were substituted (a malformed name like `{{ my-key }}`) — fail loud. */
const LEFTOVER_PLACEHOLDER_RE = /\{\{[\s\S]*?\}\}/;

/** Header names / query keys whose VALUE is a credential and must be masked. */
const SENSITIVE_NAME_RE =
  /^(authorization|cookie|set-cookie|proxy-authorization)$|api[-_]?key|token|secret|password|bearer/i;

/** True for a string that is exactly one `{{PLACEHOLDER}}` (and nothing else). */
const BARE_PLACEHOLDER_RE = /^\{\{\s*[A-Za-z0-9_]+\s*\}\}$/;

/** Timeout floor — mirrors the JSON-schema `minimum` for `timeoutMs`. */
const MIN_TIMEOUT = 1000;

/** True if `template` references at least one `{{PLACEHOLDER}}`. */
export function hasPlaceholders(template: string): boolean {
  return HAS_PLACEHOLDER_RE.test(template);
}

/**
 * Core placeholder replacement. Replaces every strict `{{NAME}}` with the matching
 * user secret (optionally `transform`-ed, e.g. percent-encoded for a URL) and
 * collects each RAW resolved value into `used`, so the caller can scrub reflections
 * of it from the response. Throws:
 *   - `[MISSING_SECRET]` when a referenced secret isn't configured (or is empty);
 *   - `[BAD_PLACEHOLDER]` when a `{{ ... }}` pair remains that the strict grammar
 *     never matched — a malformed name like `{{ my-key }}` — rather than silently
 *     shipping the literal braces to the API.
 */
function replacePlaceholders(
  template: string,
  secrets: Record<string, string>,
  used: Set<string> | undefined,
  transform: ((value: string) => string) | undefined,
): string {
  const result = template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = secrets[name];
    if (value === undefined || value === '') {
      throw new Error(
        `[MISSING_SECRET] no stored secret named "${name}". Open this app's settings, save the key under "${name}", then reference it as {{${name}}}.`,
      );
    }
    used?.add(value);
    return transform ? transform(value) : value;
  });
  // Strip the VALID placeholders from the ORIGINAL (not the substituted output, so a
  // resolved value that happens to contain braces can't false-positive) and reject
  // anything that still looks like a `{{ ... }}` reference.
  if (LEFTOVER_PLACEHOLDER_RE.test(template.replace(PLACEHOLDER_RE, ''))) {
    throw new Error(
      '[BAD_PLACEHOLDER] a {{...}} reference is malformed — a secret name may only contain letters, digits and "_"',
    );
  }
  return result;
}

/**
 * Replace every `{{NAME}}` in `template` with the matching user secret. The result
 * is used ONLY to build the outgoing request — never logged or returned to the
 * model. Pass a `used` set to collect the resolved values for response scrubbing.
 */
export function substituteSecrets(
  template: string,
  secrets: Record<string, string>,
  used?: Set<string>,
): string {
  return replacePlaceholders(template, secrets, used, undefined);
}

/**
 * Like `substituteSecrets`, but percent-encodes each resolved value so a secret
 * carrying URL metacharacters (`/`, `?`, `#`, `&`, space) embedded in a URL string
 * cannot break out of its component (path / query injection). The RAW value is
 * still what gets collected into `used` for response scrubbing.
 */
export function substituteSecretsInUrl(
  template: string,
  secrets: Record<string, string>,
  used?: Set<string>,
): string {
  return replacePlaceholders(template, secrets, used, encodeURIComponent);
}

/**
 * Resolve + clamp a caller-supplied timeout. A non-finite value (NaN, "abc",
 * Infinity) falls back to `def` instead of poisoning `setTimeout` (NaN coerces to
 * 0 → aborts instantly). Finite values are clamped to [MIN_TIMEOUT, max].
 */
export function resolveTimeout(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, MIN_TIMEOUT), max);
}

/**
 * Replace every occurrence of any resolved secret VALUE — and its percent-encoded
 * form — with "***", recursively across strings / arrays / objects (keys included).
 * The last line of defence against an endpoint that REFLECTS a secret back in its
 * response body, a header, or an error message. `maskByName` handles credential-
 * NAMED fields; this handles the credential VALUE wherever it lands.
 */
export function scrubSecrets<T>(value: T, secretValues: Iterable<string>): T {
  const needles = buildNeedles(secretValues);
  if (needles.length === 0) return value;
  return scrub(value, needles) as T;
}

function buildNeedles(secretValues: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const v of secretValues) {
    if (!v) continue;
    set.add(v);
    try {
      set.add(encodeURIComponent(v));
    } catch {
      /* lone surrogate — the raw form still scrubs */
    }
  }
  // Longest needle first so a value that is a prefix of another is fully replaced.
  return [...set].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
}

function scrubString(s: string, needles: string[]): string {
  let out = s;
  for (const n of needles) {
    if (out.includes(n)) out = out.split(n).join('***');
  }
  return out;
}

function scrub(value: unknown, needles: string[]): unknown {
  if (typeof value === 'string') return scrubString(value, needles);
  if (Array.isArray(value)) return value.map((v) => scrub(v, needles));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubString(k, needles)] = scrub(v, needles);
    }
    return out;
  }
  return value;
}

/**
 * Mask a value when its name looks like a credential. A bare `{{PLACEHOLDER}}`
 * is passed through untouched — the placeholder name is not itself a secret, and
 * showing it back helps the model see what it referenced.
 */
export function maskByName(name: string, value: string): string {
  if (BARE_PLACEHOLDER_RE.test(value)) return value;
  return SENSITIVE_NAME_RE.test(name) ? '***' : value;
}

/** Redact literal credentials in a URL's query string, leaving {{X}} intact. */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&](?:api[-_]?key|key|token|access_token|apikey|auth)=)([^&#\s]+)/gi,
    (_m, prefix: string, val: string) => (val.startsWith('{{') ? `${prefix}${val}` : `${prefix}***`),
  );
}

/** Apply maskByName across every entry of a record (headers / query). */
export function redactRecord(rec: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(rec)) out[key] = maskByName(key, String(value));
  return out;
}
