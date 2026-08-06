/**
 * Webhook URL guard for mca.make.
 *
 * SECURITY: `trigger-webhook` POSTs to a URL supplied as a tool argument. Without
 * a host allowlist the agent could be steered into an SSRF — POSTing arbitrary
 * (possibly attacker-controlled) payloads to internal services or arbitrary
 * hosts. We therefore reject any URL whose host is not a Make.com webhook host
 * (`*.make.com`) and any non-`https` protocol. The `[BAD_REQUEST]` code lets the
 * LLM know the argument is wrong (not a transient failure).
 *
 * `new URL()` is the parser of record: it correctly attributes the host for
 * tricky inputs (`https://hook.eu1.make.com@evil.com/` → host `evil.com`;
 * `https://hook.eu1.make.com.evil.com/` → host ends with `.evil.com`), so the
 * `endsWith('.make.com')` check is robust against userinfo/suffix spoofing.
 */

import { MakeError } from './errors';

/** Only hosts ending in this suffix are accepted (the canonical webhook host is `hook.<region>.make.com`). */
export const MAKE_DOMAIN_SUFFIX = '.make.com';

export interface ParsedWebhookUrl {
  /** Normalized absolute URL (used for the actual POST). */
  url: string;
  /** Lowercased hostname (safe to surface in logs/UI — contains no token). */
  host: string;
  /** Region parsed from `hook.<region>.make.com`, or null for non-standard hosts. */
  region: string | null;
}

/**
 * Validate and parse a Make.com webhook URL. Throws `MakeError('BAD_REQUEST')`
 * for anything that is not an `https://*.make.com` URL.
 */
export function parseMakeWebhookUrl(rawUrl: unknown): ParsedWebhookUrl {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new MakeError('BAD_REQUEST', 'webhookUrl is required and must be a non-empty string');
  }

  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new MakeError('BAD_REQUEST', `webhookUrl is not a valid URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new MakeError(
      'BAD_REQUEST',
      `webhookUrl must use https:// (got "${parsed.protocol}//")`,
    );
  }

  // A genuine Make webhook is always served on the default https port. Reject an
  // explicit non-443 port — it can only be an attempt to reach a different
  // service on a host that happens to resolve to make.com (SSRF defense-in-depth).
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new MakeError(
      'BAD_REQUEST',
      `webhookUrl must use the default https port (got ":${parsed.port}")`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(MAKE_DOMAIN_SUFFIX)) {
    throw new MakeError(
      'BAD_REQUEST',
      `webhookUrl host "${host}" is not allowed — only Make.com webhooks (*${MAKE_DOMAIN_SUFFIX}) are permitted`,
    );
  }

  return { url: parsed.toString(), host, region: regionFromHost(host) };
}

/** `hook.eu1.make.com` → `eu1`; non-standard hosts → null. */
export function regionFromHost(host: string): string | null {
  const match = /^hook\.([a-z0-9-]+)\.make\.com$/.exec(host);
  return match ? match[1] : null;
}
