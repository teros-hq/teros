import { type ToolConfig, safeFetch } from '@teros/mca-sdk';
import {
  hasPlaceholders,
  maskByName,
  redactRecord,
  redactUrl,
  resolveTimeout,
  scrubSecrets,
  substituteSecrets,
  substituteSecretsInUrl,
} from '../lib/http-utils';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TIMEOUT = 120 * 1000; // 2 minutes
const DEFAULT_TIMEOUT = 30 * 1000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Stream the response body with a HARD byte cap. `content-length` is advisory
 * (absent on chunked responses, trivially spoofable), so we read incrementally via
 * the body reader and ABORT the moment the cumulative size crosses the cap — never
 * materialising an unbounded buffer in memory (OOM guard). Throws
 * `[RESPONSE_TOO_LARGE]` instead of silently truncating a partial/duplicitous body.
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; sizeBytes: number }> {
  const body = response.body;
  if (!body) return { text: '', sizeBytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('[RESPONSE_TOO_LARGE] response exceeds the 5MB limit');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), sizeBytes: total };
}

export const httpRequest: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Make an HTTP request to any public REST API (GET/POST/PUT/PATCH/DELETE) and return { status, ok, headers, body }. ' +
    "To use an API key WITHOUT exposing it, save it once in this app's settings and reference it as {{NAME}} in the url, a query value, or a header value — " +
    'e.g. header "api-key: {{BREVO_API_KEY}}" (Brevo), query api_key="{{HUNTER_API_KEY}}" (Hunter.io), or url ".../{{MAKE_WEBHOOK_TOKEN}}" (Make webhook). ' +
    'Private/internal addresses are blocked (SSRF-safe). Response body is parsed as JSON when the content-type says so. ' +
    'Threat note: a stored secret is NOT bound to a host — this tool can send any saved key to whatever host the request targets, so only store keys you accept could egress to an attacker-chosen host (e.g. via prompt injection).',
  parameters: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'HTTP method. Defaults to GET.',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        default: 'GET',
      },
      url: {
        type: 'string',
        description:
          'Full https:// URL (may contain {{SECRET}} placeholders). In production, plain http:// is refused for requests that carry secrets.',
      },
      headers: {
        type: 'object',
        description:
          'Request headers. Values may contain {{SECRET}} placeholders. Content-Type defaults to application/json when a body is sent.',
        additionalProperties: { type: 'string' },
      },
      query: {
        type: 'object',
        description: 'Query-string parameters appended to the URL. Values may contain {{SECRET}} placeholders.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        description: 'Raw request body (e.g. a JSON string). Ignored for GET. May contain {{SECRET}} placeholders.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Request timeout in milliseconds (default 30000, min 1000, max 120000).',
        minimum: 1000,
        maximum: 120000,
        default: DEFAULT_TIMEOUT,
      },
    },
    required: ['url'],
  },
  handler: async (args, context) => {
    const method = String(args?.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`[BAD_METHOD] method must be one of ${[...ALLOWED_METHODS].join(', ')}`);
    }
    const rawUrl = args?.url;
    if (!rawUrl || typeof rawUrl !== 'string') {
      throw new Error('[BAD_REQUEST] "url" is required and must be a string');
    }
    const rawHeaders = (args?.headers ?? {}) as Record<string, string>;
    const rawQuery = (args?.query ?? {}) as Record<string, string>;
    const rawBody = typeof args?.body === 'string' ? (args.body as string) : undefined;
    const timeoutMs = resolveTimeout(args?.timeoutMs, DEFAULT_TIMEOUT, MAX_TIMEOUT);

    // The resolved secret VALUES used to build this request. Collected as we
    // substitute so they can be scrubbed from anything handed back to the model
    // (response payload AND error messages — an endpoint or SSRF error may reflect
    // a secret embedded in the host/path).
    const usedSecrets = new Set<string>();
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const sendBody = rawBody !== undefined && rawBody !== '' && method !== 'GET';

      // C1 — LAZY secrets: only resolve the caller's stored secrets when a field
      // actually references one. A request WITHOUT placeholders must work for a
      // user who has saved zero secrets (the backend rejects getUserSecrets() then).
      const needsSecrets =
        hasPlaceholders(rawUrl) ||
        Object.values(rawQuery).some((v) => hasPlaceholders(String(v))) ||
        Object.values(rawHeaders).some((v) => hasPlaceholders(String(v))) ||
        (sendBody && hasPlaceholders(rawBody as string));

      // `.catch(() => ({}))`: when a user has no secrets, fall through to a clean
      // `[MISSING_SECRET] no stored secret named "X"` from substitution, not the
      // opaque "No user secrets available" the SDK throws.
      const secrets: Record<string, string> = needsSecrets
        ? await context.getUserSecrets().catch(() => ({}))
        : {};

      // Final URL: substitute (percent-encoded) secrets in the URL string, then
      // append query params (URLSearchParams encodes those itself — pass raw).
      let urlObj: URL;
      try {
        urlObj = new URL(substituteSecretsInUrl(rawUrl, secrets, usedSecrets));
      } catch (err) {
        if (err instanceof Error && /^\[(MISSING_SECRET|BAD_PLACEHOLDER)\]/.test(err.message)) {
          throw err;
        }
        throw new Error(`[BAD_URL] not a valid URL: ${rawUrl}`);
      }

      // M6 — never carry secrets over plaintext http:// in production. Decided on
      // the RESOLVED protocol and BEFORE the request is sent: no secret leaves.
      if (needsSecrets && urlObj.protocol === 'http:' && process.env.NODE_ENV === 'production') {
        throw new Error(
          '[INSECURE_TRANSPORT] refusing to send {{secrets}} over plaintext http:// in production — use https://',
        );
      }

      for (const [key, value] of Object.entries(rawQuery)) {
        urlObj.searchParams.set(key, substituteSecrets(String(value), secrets, usedSecrets));
      }
      const finalUrl = urlObj.toString();

      // Headers with secrets substituted (raw — header values aren't URL-encoded).
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key] = substituteSecrets(String(value), secrets, usedSecrets);
      }

      // Body only for methods that carry one; default Content-Type to JSON.
      let body: string | undefined;
      if (sendBody) {
        body = substituteSecrets(rawBody as string, secrets, usedSecrets);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json';
        }
      }

      timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // SSRF-safe: safeFetch resolves DNS and rejects private/loopback/link-local/
      // internal addresses, and re-validates every redirect hop.
      const response = await safeFetch(finalUrl, { method, headers, body, signal: controller.signal });

      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error('[RESPONSE_TOO_LARGE] response exceeds the 5MB limit');
      }

      const { text, sizeBytes } = await readBodyCapped(response, MAX_RESPONSE_SIZE);
      const contentType = response.headers.get('content-type') ?? '';
      const ct = contentType.toLowerCase();

      // Parse JSON from the ORIGINAL (valid) text; the recursive scrub below masks
      // any reflected secret in the parsed structure. Non-JSON stays a string and
      // is scrubbed there. Both "stringified" and "after parse" angles are covered.
      let responseBody: unknown = text;
      if (ct.includes('application/json')) {
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
      }

      // Name-mask credential-looking headers; the scrub pass then masks credential
      // VALUES reflected under any (even non-credential) header name.
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = maskByName(key, value);
      });

      const result = {
        request: {
          method,
          // Echo back what the caller wrote (placeholders intact); mask any literal credentials.
          url: redactUrl(rawUrl),
          headers: redactRecord(rawHeaders),
          query: redactRecord(rawQuery),
          hasBody: sendBody,
        },
        response: {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          contentType,
          headers: responseHeaders,
          body: responseBody,
          sizeBytes,
          // We abort over-cap responses (see readBodyCapped) rather than truncate,
          // so a returned body is always complete. Kept for renderer shape stability.
          truncated: false,
        },
      };

      // C2 — final defence: replace any reflected secret VALUE (raw or %-encoded)
      // with "***" everywhere returned (response body, headers, request echo) in one
      // recursive pass. Defends against an endpoint that echoes the key it received.
      return scrubSecrets(result, usedSecrets);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.name === 'AbortError') {
        throw new Error(`[TIMEOUT] request exceeded ${Math.round(timeoutMs / 1000)}s`);
      }
      // safeFetch's BlockedUrlError / [MISSING_SECRET] / [BAD_PLACEHOLDER] / [BAD_URL]
      // already carry a [CODE] prefix; scrub any secret value the message might echo
      // (a blocked host/path can embed one) before it reaches the model.
      throw new Error(scrubSecrets(err.message, usedSecrets));
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  },
};
