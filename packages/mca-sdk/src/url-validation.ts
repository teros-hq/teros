/**
 * SSRF guard for MCAs that reach out to caller-supplied URLs (S1 — shared so the
 * same hole is closed once, not copied across mca.teros.{design,webfetch,playwright}).
 *
 * Unlike ImagePipeline's allowlist (only fetch configured CDNs), these MCAs MUST
 * reach arbitrary PUBLIC sites — so the model is a DENYLIST + DNS resolution:
 * resolve the host and reject if ANY resolved address is loopback / private /
 * link-local (incl. the cloud metadata endpoint 169.254.169.254) / ULA / internal.
 * Validating only the literal input is not enough: a hostname can resolve to an
 * internal IP, and redirects can hop to one — `safeFetch` follows redirects
 * manually, re-validates every hop, and strips credentials on cross-origin hops.
 *
 * LIMIT — DNS rebinding (TOCTOU): we resolve+validate, then the global `fetch`
 * re-resolves on its own, so a host serving a 0-TTL record could answer public to
 * our check and private to the actual socket. Pinning the validated IP in the
 * client needs a custom transport (an undici dispatcher) that is incompatible with
 * the global `fetch` these MCAs replace in their tests — so the ROBUST close is
 * network egress isolation of the container (drop 169.254.0.0/16 + RFC1918 at the
 * bridge); a platform follow-up. This guard is the application-level defence: it
 * raises the bar (literal private IPs, redirect hops, credential leakage) but does
 * NOT, on its own, close the rebinding TOCTOU.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Thrown when a URL is blocked. `message` is prefixed with a `[CODE]` (SDK-wide
 *  convention) so the agent can tell a blocked-private from a bad-scheme. */
export class BlockedUrlError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → unsafe
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // RFC1918 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (cloud-internal)
  if (a >= 224) return true; // multicast / reserved 224.0.0.0+
  return false;
}

function isPrivateV6(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::') return true; // loopback / unspecified
  if (/^fe[89ab]/.test(a)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(a)) return true; // unique local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) → classify the embedded v4
  const mapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (a.startsWith('::ffff:')) return true; // mapped but non-dotted form → be safe
  return false;
}

/** True if an IP literal (v4 or v6) is non-public (loopback/private/link-local/ULA/
 *  reserved). A non-IP string is treated as unsafe (callers resolve DNS first). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  return true;
}

/** Internal hostnames that must never be reachable, regardless of DNS. */
function isInternalHostname(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'host.docker.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  );
}

/** Fast, DNS-free check: is the URL's host a LITERAL private IP / internal name?
 *  Used to block redirect hops cheaply (no per-hop DNS). */
export function isPrivateHostLiteral(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isInternalHostname(host)) return true;
    return isIP(host) !== 0 && isPrivateAddress(host);
  } catch {
    return false;
  }
}

export interface PublicUrlOptions {
  /** Ports the URL may use (default 80 + 443). */
  allowedPorts?: number[];
  /** Test seam: override DNS resolution. Defaults to node:dns `lookup(host, {all})`.
   *  Lets tests drive the rebinding case without real network or module mocking. */
  resolveHost?: (host: string) => Promise<Array<{ address: string }>>;
}

/**
 * Assert a URL is safe to reach from the server: http(s), an allowed port, and a
 * host that resolves ONLY to public addresses. Throws `BlockedUrlError` otherwise.
 * Resolves DNS (all A/AAAA records) so a hostname pointing at an internal IP is
 * caught. Call before every fetch/navigation AND on every redirect hop.
 */
export async function assertPublicUrl(url: string, opts: PublicUrlOptions = {}): Promise<void> {
  const host = parseHttpHost(url, opts.allowedPorts ?? [80, 443]);
  await assertHostPublic(host, url, opts.resolveHost ?? ((h) => lookup(h, { all: true })));
}

/** Validate scheme + port and return the (bracket-stripped, lowercased) host. */
function parseHttpHost(url: string, allowedPorts: number[]): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError(`[BLOCKED_URL] not a valid URL: ${url}`, url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedUrlError(`[BLOCKED_SCHEME] only http/https is allowed (got ${parsed.protocol})`, url);
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new BlockedUrlError(`[BLOCKED_PORT] port ${port} is not allowed`, url);
  }
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

/** Reject internal hostnames + any host resolving to a non-public address. */
async function assertHostPublic(
  host: string,
  url: string,
  resolve: (host: string) => Promise<Array<{ address: string }>>,
): Promise<void> {
  if (isInternalHostname(host)) {
    throw new BlockedUrlError(`[BLOCKED_PRIVATE] ${host} is an internal hostname`, url);
  }
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new BlockedUrlError(`[BLOCKED_PRIVATE] ${host} is a non-public address`, url);
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await resolve(host);
  } catch {
    throw new BlockedUrlError(`[BLOCKED_PRIVATE] could not resolve ${host}`, url);
  }
  if (addrs.length === 0) {
    throw new BlockedUrlError(`[BLOCKED_PRIVATE] ${host} resolved to no addresses`, url);
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new BlockedUrlError(`[BLOCKED_PRIVATE] ${host} resolves to a non-public address (${a.address})`, url);
    }
  }
}

/** Redirect cap for safeFetch (each hop is re-validated). */
export const MAX_SAFE_REDIRECTS = 5;

/** Request headers that must not survive a redirect to a different origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

/** Drop credential headers from an init (used when a redirect crosses origin). */
function stripCredentialHeaders(init: RequestInit): RequestInit {
  if (!init.headers) return init;
  const h = new Headers(init.headers as HeadersInit);
  let stripped = false;
  for (const name of CREDENTIAL_HEADERS) {
    if (h.has(name)) {
      h.delete(name);
      stripped = true;
    }
  }
  return stripped ? { ...init, headers: h } : init;
}

/** `host:port` of a URL, or '' if it can't be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * Like `fetch`, but SSRF-safe: validates the URL and follows redirects MANUALLY,
 * re-validating every hop with `assertPublicUrl`. On a CROSS-ORIGIN redirect it
 * strips credential headers (`Authorization`/`Cookie`/`Proxy-Authorization`) so an
 * open-redirect on a trusted API can't hand the user's key — or the resolved
 * `{{secret}}` — to an attacker-chosen host; and 301/302/303 are downgraded to GET
 * with the body dropped (fetch spec), so a secret-bearing POST body isn't replayed.
 * Returns the first non-redirect response (caller checks `response.ok`).
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: PublicUrlOptions & { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? MAX_SAFE_REDIRECTS;
  let current = url;
  let currentInit: RequestInit = init;
  let currentHost = hostOf(url);
  let hop = 0;
  while (true) {
    await assertPublicUrl(current, opts);
    const res = await fetch(current, { ...currentInit, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    if (hop >= maxRedirects) {
      throw new BlockedUrlError(`[BLOCKED_REDIRECT] too many redirects (>${maxRedirects})`, url);
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new BlockedUrlError(`[BLOCKED_REDIRECT] redirect ${res.status} with no Location header`, url);
    }
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new BlockedUrlError(`[BLOCKED_REDIRECT] malformed redirect Location: ${location}`, url);
    }
    const nextHost = hostOf(next);
    // M2a — a cross-origin redirect must NOT carry the user's credentials onward.
    if (nextHost !== currentHost) {
      currentInit = stripCredentialHeaders(currentInit);
    }
    // M2b — 301/302/303 become GET and drop the body (a secret-bearing POST body
    // must not be replayed verbatim to the redirect target).
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      currentInit = { ...currentInit, method: 'GET', body: undefined };
    }
    current = next;
    currentHost = nextHost;
    hop++;
  }
}

/** Minimal structural view of a Playwright Page — avoids an mca-sdk dependency on
 *  playwright while letting browser MCAs pass their real page. */
export interface NavigablePage {
  goto(url: string, options?: unknown): Promise<unknown>;
  route?(pattern: string, handler: (route: PlaywrightRoute) => unknown): Promise<void>;
  unroute?(pattern: string, handler?: (route: PlaywrightRoute) => unknown): Promise<void>;
  mainFrame?(): unknown;
}
interface PlaywrightRoute {
  request(): { url(): string; isNavigationRequest(): boolean; frame(): unknown };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

/**
 * Navigate a browser page SSRF-safely: assert the input URL is public, then, when
 * the page supports request interception, block any top-level redirect hop that
 * targets a LITERAL private IP (catches redirect-to-169.254.169.254). Hostname
 * hops are not re-resolved here (browser-internal); the input is fully resolved.
 */
export async function navigateSafely<T = unknown>(
  page: NavigablePage,
  url: string,
  opts: PublicUrlOptions & { gotoOptions?: unknown } = {},
): Promise<T> {
  await assertPublicUrl(url, opts);
  if (typeof page.route === 'function' && typeof page.mainFrame === 'function') {
    const handler = (route: PlaywrightRoute) => {
      try {
        const req = route.request();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame!() && isPrivateHostLiteral(req.url())) {
          return route.abort('blockedbyclient');
        }
      } catch {
        /* fall through */
      }
      return route.continue();
    };
    await page.route('**/*', handler);
    try {
      return (await page.goto(url, opts.gotoOptions)) as T;
    } finally {
      if (typeof page.unroute === 'function') await page.unroute('**/*', handler).catch(() => {});
    }
  }
  return (await page.goto(url, opts.gotoOptions)) as T;
}
