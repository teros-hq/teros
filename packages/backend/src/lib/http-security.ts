/**
 * HTTP edge-security helpers — CORS origin allowlisting, client-IP extraction,
 * and IP allowlist matching (exact + IPv4 CIDR + loopback).
 *
 * Pure functions, no I/O — unit-testable in isolation (FASE 5a).
 *
 * Why: the platform served `Access-Control-Allow-Origin: *` to every request
 * and exposed `/metrics` (billing/usage instrumentation) to anyone who could
 * reach the port. These helpers let the edge reflect only allowlisted origins
 * and gate `/metrics` to internal IPs as defense-in-depth behind the reverse
 * proxy.
 */

import { timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

/**
 * Constant-time string comparison for secret/token checks.
 *
 * Length mismatches short-circuit before `timingSafeEqual` (buffer length
 * itself isn't secret; `timingSafeEqual` throws on unequal-length buffers).
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * Resolve the `TRUST_PROXY` config default from the raw env value.
 *
 * Defaults to `false`: a clone-and-run deployment with no reverse proxy in
 * front must not trust the caller-supplied `X-Forwarded-For` header, or it
 * defeats both the `/metrics` IP allowlist and the per-IP rate limiter (see
 * `extractClientIp`). Only an explicit `"true"` (set behind nginx/Traefik,
 * which overwrites inbound XFF) opts in.
 */
export function resolveTrustProxyDefault(raw: string | undefined): boolean {
  return raw === "true"
}

/**
 * Resolve the `Access-Control-Allow-Origin` value for a request.
 *
 * - Returns the request's Origin verbatim when it is in the allowlist, so the
 *   response echoes a single concrete origin (never a bare `*` for the API/WS).
 * - Returns the literal `*` only when the allowlist itself contains `*`
 *   (used for public static assets, never with credentials).
 * - Returns `null` when the origin is not allowed → the caller omits the header
 *   and the browser blocks the cross-origin response.
 */
export function resolveAllowedOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
): string | null {
  if (allowlist.includes("*")) return "*"
  if (!origin) return null
  return allowlist.includes(origin) ? origin : null
}

/**
 * Add the app's own origin (from `APP_URL`) to a CORS allowlist.
 *
 * A compose install serves the web and the backend on different ports; the
 * credentialed session-cookie calls need the web origin reflected, and
 * `APP_URL` already says where the web lives. Appended, never substituted;
 * untouched when the list is `*` or the URL is missing or malformed.
 *
 * @spec CORSAPP-REQ-1 CORSAPP-REQ-2 CORSAPP-REQ-3
 */
export function withAppOrigin(allowlist: readonly string[], appUrl: string | undefined): string[] {
  const list = [...allowlist]
  if (list.includes("*") || !appUrl) return list
  let origin: string
  try {
    origin = new URL(appUrl).origin
  } catch {
    return list
  }
  if (origin === "null" || list.includes(origin)) return list
  return [...list, origin]
}

/**
 * Strip the IPv4-mapped IPv6 prefix so `::ffff:127.0.0.1` matches `127.0.0.1`.
 */
function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip
}

/**
 * Extract the client IP from a request.
 *
 * When `trustProxy` is true (behind nginx/Traefik in prod), the left-most entry
 * of `X-Forwarded-For` is the originating client. When false, only the direct
 * TCP peer (`socket.remoteAddress`) is trusted — `X-Forwarded-For` is
 * attacker-controlled and ignored.
 */
export function extractClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"]
    const raw = Array.isArray(xff) ? xff[0] : xff
    const first = raw?.split(",")[0]?.trim()
    if (first) return normalizeIp(first)
  }
  return normalizeIp(req.socket?.remoteAddress ?? "")
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let acc = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    acc = (acc << 8) | n
  }
  return acc >>> 0
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/")
  const range = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range)
  if (ipInt === null || rangeInt === null) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

/**
 * Extract the origin (scheme://host[:port]) from a URL string.
 * Returns null for malformed input.
 *
 * @example "https://os.teros.ai/dashboard" → "https://os.teros.ai"
 */
function extractOriginFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    // Origin = scheme + host + port (URL.origin handles port normalization)
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Validate the Origin/Referer of a state-changing request against the CORS
 * allowlist (Req 3.1.5 — anti-CSRF defense-in-depth).
 *
 * Checks the `Origin` header first (sent by browsers on all cross-origin and
 * same-origin POST/PUT/DELETE/PATCH requests). If `Origin` is absent, falls
 * back to the `Referer` header and extracts its origin portion.
 *
 * Returns `true` when:
 * - The allowlist contains `"*"` (CORS is fully open — CSRF check is moot).
 * - The `Origin` header is present and matches an allowlisted origin exactly.
 * - The `Origin` header is absent but the `Referer` header's origin matches.
 *
 * Returns `false` when:
 * - Neither `Origin` nor `Referer` is present (state-changing requests must
 *   carry an origin signal; non-browser clients use token/signature auth and
 *   are exempt at the call site).
 * - The origin is present but not in the allowlist.
 *
 * @param origin  The raw `Origin` header value (or undefined).
 * @param referer The raw `Referer` header value (or undefined).
 * @param allowlist  The same allowlist used by `resolveAllowedOrigin`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  referer: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (allowlist.includes("*")) return true

  // Prefer the Origin header — it's the precise, browser-sent origin.
  if (origin) {
    return allowlist.includes(origin)
  }

  // Fall back to Referer: extract the origin portion and compare.
  if (referer) {
    const refererOrigin = extractOriginFromUrl(referer)
    if (refererOrigin) {
      return allowlist.includes(refererOrigin)
    }
  }

  // No origin signal at all — reject for state-changing requests.
  return false
}

/**
 * Build the Strict-Transport-Security (HSTS) header value (Req 4.1.1).
 *
 * HSTS tells browsers to always use HTTPS for the site for the given max-age,
 * preventing SSL-stripping and protocol-downgrade attacks. The header is only
 * honored by browsers over HTTPS (RFC 6797 §8.1) — `shouldSetHsts` gates it.
 *
 * @param maxAgeSeconds  The duration (seconds) the browser should enforce HTTPS.
 * @param includeSubDomains  When true, the policy applies to all subdomains.
 * @param preload  When true, signals willingness to be included in browser
 *   HSTS preload lists. Only enable after meeting preload requirements
 *   (https://hstspreload.org).
 */
export function buildHstsHeader(
  maxAgeSeconds: number,
  includeSubDomains: boolean,
  preload: boolean,
): string {
  let value = `max-age=${maxAgeSeconds}`
  if (includeSubDomains) value += '; includeSubDomains'
  if (preload) value += '; preload'
  return value
}

/**
 * Determine whether the HSTS header should be set on the response (Req 4.1.1).
 *
 * HSTS is only meaningful over HTTPS. This backend runs behind a TLS-terminating
 * reverse proxy (nginx/Traefik) in production, so the app itself receives plain
 * HTTP. When `trustProxy` is true, we inspect `X-Forwarded-Proto` to see if the
 * original client→proxy connection was HTTPS. When `trustProxy` is false (local
 * dev, no proxy), we never set HSTS — the server listens on plain HTTP and
 * browsers ignore HSTS over HTTP anyway (RFC 6797 §8.1).
 *
 * @param req  The incoming HTTP request.
 * @param trustProxy  Whether to trust X-Forwarded-Proto (true behind a proxy).
 * @returns true if the HSTS header should be set on the response.
 */
export function shouldSetHsts(req: IncomingMessage, trustProxy: boolean): boolean {
  if (!trustProxy) return false
  const proto = req.headers['x-forwarded-proto']
  const raw = Array.isArray(proto) ? proto[0] : proto
  return raw?.trim().toLowerCase() === 'https'
}

/**
 * Match an IP against an allowlist of exact IPs and IPv4 CIDR ranges.
 *
 * Exact entries match by normalized string (covers IPv6 such as `::1`); entries
 * containing `/` are treated as IPv4 CIDR. A malformed entry never matches.
 */
/**
 * Decide whether a `/metrics` request may be served.
 *
 * Two independent ways in:
 *   - a bearer token (`METRICS_TOKEN`) — works from anywhere, meant for the
 *     canary / a scraper outside the host;
 *   - the IP allowlist — but ONLY when the IP is meaningful: in production the
 *     backend sits behind a reverse proxy, so without TRUST_PROXY the socket
 *     address is the proxy's own (private, always allowlisted) and the gate was
 *     letting the whole internet in (found 2026-10-15: be.teros.ai/metrics was
 *     public). Production therefore requires TRUST_PROXY=true for the IP path.
 */
export function isMetricsRequestAllowed(input: {
  clientIp: string
  allowlist: readonly string[]
  trustProxy: boolean
  production: boolean
  authorization: string | string[] | undefined
  token: string | null
}): boolean {
  if (input.token) {
    const raw = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization
    if (raw && timingSafeStringEqual(raw, `Bearer ${input.token}`)) return true
  }
  if (input.production && !input.trustProxy) return false
  return isIpAllowed(input.clientIp, input.allowlist)
}

export function isIpAllowed(ip: string, allowlist: readonly string[]): boolean {
  const norm = normalizeIp(ip)
  if (!norm) return false
  for (const entry of allowlist) {
    if (entry.includes("/")) {
      if (ipv4InCidr(norm, entry)) return true
    } else if (entry === norm) {
      return true
    }
  }
  return false
}
