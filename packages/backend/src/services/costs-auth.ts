/**
 * Costs API authentication — static per-environment API key (task_6de67c22b163387a).
 *
 * The external costs panel (Railway BFF) is the ONLY intended consumer of the
 * `/api/costs/*` surface. There is no read-only Mongo user and no DB auth —
 * the backend is the entry point, and the panel authenticates with a static
 * API key, ONE PER ENVIRONMENT (raw / prod), delivered via:
 *
 *   1. `.secrets/system/costs.json` → `{ "apiKey": "<openssl rand -hex 32>" }`
 *      (house pattern — same as admin.json; gitignored, never in the repo)
 *   2. `COSTS_API_KEY` env var (explicit fallback for env-only deployments)
 *
 * Rotation = edit the secret/env + restart the backend (Pablo manages
 * restarts). No code deploy needed.
 *
 * Header: `X-API-Key: <key>` — NOT `Authorization: Bearer`. Deliberate:
 * Bearer is the platform's session/admin/metrics credential channel; a
 * dedicated header keeps the costs key from ever being confused with (or
 * replayed against) a user session. `X-API-Key` is also NOT in the CORS
 * allow-headers list, so a browser cannot even preflight it — the key must
 * never travel from a browser, only from the server-side BFF.
 *
 * Scope (task requirement): the key authorizes EXACTLY `/api/costs/*` GETs.
 * http-server rejects any other path carrying an `X-API-Key` header with a
 * generic 403 BEFORE routing (checkApiKeyScope) — no oracle about what
 * exists. On the costs surface itself: missing key → 401, invalid key → 401
 * (identical bodies), unknown endpoint → 404, non-GET → 405, over limit →
 * 429, no key configured → 404 (surface disabled).
 *
 * Audit: every `/api/costs/*` request (and every scope-violation attempt) is
 * logged to `costs_access_logs` — timestamp, endpoint, from/to, seg,
 * environment, ip, userAgent, outcome, status and a key FINGERPRINT
 * (sha256 prefix — the key itself is never stored). A pino line always
 * emits even when the DB write fails, mirroring lib/audit-logger.ts.
 *
 * Rate limit: fixed 60s window per key fingerprint, default 60 req/min
 * (`COSTS_RATE_LIMIT_PER_MIN`, 0 disables). The panel refreshes every few
 * hours — anything beyond that is abuse or a bug. The edge's global per-IP
 * limiter still applies on top (defense in depth).
 */

import { createHash } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Collection, Db } from "mongodb"
import { COLLECTIONS } from "../db"
import { createLogger } from "../lib/logger"
import { timingSafeStringEqual } from "../lib/http-security"

const logger = createLogger("CostsAuth")

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Pure key resolution: the secret-file value wins over the `COSTS_API_KEY`
 * env var. Blank/whitespace values count as unset. Null → the whole costs
 * surface is disabled (404) — never expose cross-tenant financial data open.
 */
export function resolveCostsApiKeyFrom(
  secretValue: string | null | undefined,
  envValue: string | null | undefined,
): string | null {
  const fromSecrets = secretValue?.trim()
  if (fromSecrets) return fromSecrets
  const fromEnv = envValue?.trim()
  if (fromEnv) return fromEnv
  return null
}

/**
 * First 12 hex chars of sha256(key) — identifies a key in logs and audit
 * entries without ever storing the key itself.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12)
}

/**
 * Timing-safe presented-vs-configured comparison. A null configured key
 * never matches anything (the surface is disabled before this is reached).
 */
export function apiKeyMatches(presented: string, configured: string | null): boolean {
  if (!configured) return false
  return timingSafeStringEqual(presented, configured)
}

// ---------------------------------------------------------------------------
// Environment label (for the access log)
// ---------------------------------------------------------------------------

/**
 * Resolve the environment label written to every access-log entry.
 * `COSTS_ENV` overrides everything; otherwise the SERVER_BASE_URL host wins
 * (raw-be. contains be.teros.ai, so the specific hosts are checked first);
 * last resort NODE_ENV. Pure — takes its inputs so tests can pin them.
 */
export function resolveCostsEnv(
  serverBaseUrl: string | undefined,
  nodeEnv: string | undefined,
  override: string | undefined,
): string {
  const o = override?.trim()
  if (o) return o
  const base = serverBaseUrl || ""
  if (base.includes("raw-be.")) return "raw"
  if (base.includes("pre-be.")) return "pre"
  if (base.includes("be.teros.ai")) return "prod"
  return nodeEnv === "production" ? "prod" : "dev"
}

// ---------------------------------------------------------------------------
// Header extraction + scope guard
// ---------------------------------------------------------------------------

/** The one header the costs API key travels in (lowercase, as node exposes it). */
export const COSTS_API_KEY_HEADER = "x-api-key"

/** Presented key from the X-API-Key header; null when absent or blank. */
export function extractApiKey(req: IncomingMessage): string | null {
  const raw = req.headers[COSTS_API_KEY_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  const trimmed = value?.trim()
  return trimmed || null
}

/** User agent for audit entries (array-safe, null when absent). */
export function extractUserAgent(req: IncomingMessage): string | null {
  const raw = req.headers["user-agent"]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value ?? null
}

export interface ApiKeyScopeCheck {
  /** True when a presented X-API-Key targets a path outside /api/costs/*. */
  violation: boolean
  /** Path without query string. */
  path: string
  /** Fingerprint of the presented key (null when no key presented). */
  keyFingerprint: string | null
}

/**
 * Scope guard used by http-server BEFORE any routing: a request presenting
 * `X-API-Key` (valid or not) is a machine call authenticated by the static
 * costs key, which authorizes EXACTLY the `/api/costs/*` read-only surface.
 * Anything else carrying it is a scope violation → generic 403 that does
 * not reveal what exists. Requests without the header are never affected.
 */
export function checkApiKeyScope(req: IncomingMessage, url: string): ApiKeyScopeCheck {
  const path = url.split("?")[0]
  const presented = extractApiKey(req)
  if (presented == null) return { violation: false, path, keyFingerprint: null }
  return {
    violation: !path.startsWith("/api/costs/"),
    path,
    keyFingerprint: keyFingerprint(presented),
  }
}

// ---------------------------------------------------------------------------
// Rate limit — fixed window per key fingerprint, in memory
// ---------------------------------------------------------------------------

export interface CostsRateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

/**
 * Fixed-window in-memory rate limiter, one window per key fingerprint.
 * Single-instance by design (the backend runs one process per environment);
 * the Mongo-backed edge limiter covers the multi-instance case globally.
 */
export class CostsKeyRateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>()
  private readonly windowMs: number
  readonly limit: number

  constructor(
    limitPerMin: number,
    windowMs = 60_000,
    private nowFn: () => number = Date.now,
  ) {
    this.limit = Math.max(0, Math.floor(limitPerMin))
    this.windowMs = windowMs
  }

  get disabled(): boolean {
    return this.limit === 0
  }

  check(key: string): CostsRateLimitDecision {
    if (this.disabled) return { allowed: true, retryAfterSeconds: 0 }
    const now = this.nowFn()
    const win = this.hits.get(key)
    if (!win || now - win.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: now, count: 1 })
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (win.count < this.limit) {
      win.count++
      return { allowed: true, retryAfterSeconds: 0 }
    }
    const resetAt = win.windowStart + this.windowMs
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    }
  }
}

/**
 * Parse `COSTS_RATE_LIMIT_PER_MIN`: default 60, 0 disables, negative/NaN/garbage
 * falls back to the default (fail-closed to the defensive default, never open).
 */
export function parseRateLimitPerMin(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") return 60
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 60
  return Math.floor(n)
}

// ---------------------------------------------------------------------------
// Access log — costs_access_logs collection + always-emitted pino line
// ---------------------------------------------------------------------------

export type CostsAccessOutcome =
  | "ok"
  | "unauthorized_missing"
  | "unauthorized_invalid"
  | "rate_limited"
  | "method_not_allowed"
  | "bad_request"
  | "not_found"
  | "internal_error"
  | "disabled"
  | "scope_forbidden"

export interface CostsAccessLogEntry {
  /** When the request was served (BSON Date — GOV-3). */
  timestamp: Date
  /** Base path, e.g. /api/costs/overview. */
  endpoint: string
  /** Resolved window actually queried (ISO), when the request got that far. */
  from?: string | null
  to?: string | null
  seg?: string | null
  /** Environment label: raw | prod | pre | dev… */
  env: string
  ip?: string | null
  userAgent?: string | null
  outcome: CostsAccessOutcome
  status: number
  /** sha256(key) prefix — NEVER the key itself. */
  keyFingerprint?: string | null
}

/**
 * Costs API access logger. Singleton mirroring lib/audit-logger.ts: init(db)
 * once at bootstrap; log() is fire-and-forget and never throws — the pino
 * line always emits so the audit trail survives DB failures.
 */
class CostsAccessLogger {
  private coll: Collection<CostsAccessLogEntry> | null = null
  private initialized = false

  init(db: Db): void {
    if (this.initialized) return
    this.coll = db.collection<CostsAccessLogEntry>(COLLECTIONS.costsAccessLogs)
    this.initialized = true
    logger.info("Costs access logger initialized (collection: costs_access_logs)")
  }

  /** Test-only: detach the collection so each test file re-inits cleanly. */
  resetForTests(): void {
    this.coll = null
    this.initialized = false
  }

  log(entry: CostsAccessLogEntry): void {
    // Pino line always emits — audit events are never silently lost.
    logger.info(
      {
        endpoint: entry.endpoint,
        outcome: entry.outcome,
        status: entry.status,
        env: entry.env,
        from: entry.from ?? null,
        to: entry.to ?? null,
        seg: entry.seg ?? null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
        keyFingerprint: entry.keyFingerprint ?? null,
      },
      "costs access",
    )
    if (!this.coll) return
    try {
      this.coll.insertOne({ ...entry }).catch((err: unknown) => {
        // Persistence failure is logged, never swallowed (no-empty-catch).
        logger.error({ err, endpoint: entry.endpoint }, "costs_access_logs insert failed")
      })
    } catch (err: unknown) {
      logger.error({ err }, "costs_access_logs insert threw synchronously")
    }
  }
}

export const costsAccessLogger = new CostsAccessLogger()
