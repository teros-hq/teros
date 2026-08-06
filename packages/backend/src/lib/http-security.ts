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
 * Match an IP against an allowlist of exact IPs and IPv4 CIDR ranges.
 *
 * Exact entries match by normalized string (covers IPv6 such as `::1`); entries
 * containing `/` are treated as IPv4 CIDR. A malformed entry never matches.
 */
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
