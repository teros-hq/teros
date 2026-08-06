/**
 * Mongo-backed rate limiter (FASE 5b).
 *
 * A fixed-window counter coordinated across instances by a single atomic `$inc`
 * upsert against Mongo — the limit is GLOBAL, not per-process (chosen over an
 * in-memory bucket so it still holds when staging runs instances:2). Each window
 * is its own document keyed by `scope:key:windowStart`, pruned by a TTL index on
 * `expiresAt`.
 *
 * Tradeoff: fixed windows allow up to ~2× the limit straddling a boundary. This
 * is an abuse dampener, not a precise quota — acceptable, and far simpler than a
 * sliding-log. The real per-user money vector (agent hours) is enforced
 * separately by the billing gate.
 */

import type { Collection, Db } from "mongodb"
import type { Logger } from "../lib/logger"

export interface RateLimitRule {
  /** Fixed-window length in milliseconds. */
  windowMs: number
  /** Maximum allowed hits per window. */
  limit: number
}

export interface RateLimitDecision {
  allowed: boolean
  /** Remaining hits in the current window (never negative). */
  remaining: number
  /** Seconds until the current window resets (for the Retry-After header). */
  retryAfterSeconds: number
  /** The limit that applied (echoed for debugging / headers). */
  limit: number
}

interface RateLimitDoc {
  _id: string
  count: number
  /** Exact expiry time; a TTL index on this field prunes stale windows. */
  expiresAt: Date
}

const COLLECTION = "rate_limit_counters"

export class RateLimiter {
  private readonly col: Collection<RateLimitDoc>

  constructor(
    db: Db,
    private readonly log: Logger,
  ) {
    this.col = db.collection<RateLimitDoc>(COLLECTION)
  }

  /**
   * Atomically consume one unit from the (scope, key) fixed window.
   *
   * Fail-OPEN: if the counter store errors, the request is ALLOWED (and the
   * error logged loudly). A rate limiter must never wall the whole platform
   * because Mongo hiccuped — availability over strict enforcement. Deliberate,
   * scoped exception to fail-closed.
   */
  async consume(
    scope: string,
    key: string,
    rule: RateLimitRule,
    now: number = Date.now(),
  ): Promise<RateLimitDecision> {
    const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs
    const resetAt = windowStart + rule.windowMs
    const id = `${scope}:${key}:${windowStart}`
    try {
      const doc = await this.col.findOneAndUpdate(
        { _id: id },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(resetAt) } },
        { upsert: true, returnDocument: "after" },
      )
      const count = doc?.count ?? 1
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        retryAfterSeconds: Math.ceil((resetAt - now) / 1000),
        limit: rule.limit,
      }
    } catch (err) {
      this.log.error({ err, scope, key }, "rate-limiter: counter store error, failing open")
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, limit: rule.limit }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP edge enforcement
// ---------------------------------------------------------------------------

/** Prefixes never rate-limited: high-volume static/content + machine routes. */
const EXCLUDED_PREFIXES = [
  "/static/",
  "/uploads/",
  "/public/",
  "/pcm-processor.js",
  "/media/",
  "/api/media/",
  "/api/files",
  "/webhooks/", // signature-verified (GitHub/Stripe/app) — providers legitimately retry
  "/api/event", // MCA internal token
  "/api/mca-event", // MCA internal token
  "/api/feedback", // feedback internal token
]

/** Exact paths never rate-limited. */
const EXCLUDED_EXACT = new Set(["/health", "/metrics", "/"])

/**
 * Whether an HTTP path participates in rate limiting. Excludes high-volume
 * static/content serving and signature-/token-authenticated machine routes
 * (their own auth already gates them; providers legitimately retry).
 */
export function isRateLimitedPath(url: string): boolean {
  const path = url.split("?")[0]
  if (EXCLUDED_EXACT.has(path)) return false
  return !EXCLUDED_PREFIXES.some((p) => path.startsWith(p))
}

/** Auth surface gets a stricter limit (brute-force protection). */
export function isAuthPath(url: string): boolean {
  const path = url.split("?")[0]
  return path.startsWith("/auth/") || path.startsWith("/api/auth/")
}

export interface HttpRateLimitConfig {
  global: RateLimitRule
  perIp: RateLimitRule
  auth: RateLimitRule
}

export interface HttpRateLimitDenial extends RateLimitDecision {
  scope: string
}

/**
 * Enforce the HTTP edge rate limits for a request. Returns null when allowed
 * (or the path is excluded), or a denial (with the scope that tripped +
 * Retry-After) when blocked.
 *
 * Order: global ceiling, then per-IP, then the stricter auth limit on the auth
 * surface. The first scope to deny short-circuits — we don't consume the
 * remaining scopes' budget for an already-blocked request.
 */
export async function enforceHttpRateLimit(
  limiter: RateLimiter,
  cfg: HttpRateLimitConfig,
  ip: string,
  url: string,
  now?: number,
): Promise<HttpRateLimitDenial | null> {
  if (!isRateLimitedPath(url)) return null
  const checks: Array<{ scope: string; key: string; rule: RateLimitRule }> = [
    { scope: "global", key: "all", rule: cfg.global },
    { scope: "ip", key: ip, rule: cfg.perIp },
  ]
  if (isAuthPath(url)) checks.push({ scope: "auth", key: ip, rule: cfg.auth })
  for (const { scope, key, rule } of checks) {
    const decision = await limiter.consume(scope, key, rule, now)
    if (!decision.allowed) return { ...decision, scope }
  }
  return null
}
