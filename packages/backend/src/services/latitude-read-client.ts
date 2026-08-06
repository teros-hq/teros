/**
 * Latitude read client (F4 · C2 — the signals dashboard).
 *
 * Latitude clusters Teros' exported failures (F3a traces + C0 scores) into
 * `signals`: named, deduplicated failure groups. C2 reads that catalogue back so
 * an admin can browse it inside Teros without leaving for the Latitude web UI.
 *
 * This is the ONLY module that talks to the Latitude signals REST wire (soberanía
 * Principio 3, mirror of the C0 score client). It is INBOUND and READ-ONLY: a GET
 * carries only query params, so nothing Teros holds is sent. The fields it reads
 * back (name/description) are the cluster's own categorical labels that Latitude
 * generated — not user content — the same return-path class as C1's badge.
 *
 * Never throws. A dead / rejecting / unauthorized Latitude degrades to a
 * discriminated outcome, so the dashboard can say "unreachable" instead of
 * breaking the admin action (Latitude down → product identical).
 *
 * Verified against the live REST API + source (not the stale public docs):
 *   GET /v1/projects/{projectSlug}/signals   (apps/api/src/routes/signals.ts:280)
 *   Bearer auth, org-scoped from the token   (apps/api/src/middleware/auth.ts:26)
 *   Response { items, nextCursor, hasMore }; the read exposes NO priority and NO
 *   deepLinkUrl — the deep link is built here from the cuid `id`, per the web
 *   route /projects/{slug}/signals/{id} (apps/web/.../signals/$signalId).
 */

/** One clustered-failure signal, structural fields only. `source`/`states` stay
 * loose strings so an upstream enum addition never drops a signal (shape-agnostic). */
export interface LatitudeSignalSummary {
  id: string
  slug: string
  name: string
  description: string
  /** `annotation` | `flagger` | `custom` (kept open). */
  source: string
  /** Lifecycle states, any of `new` | `escalating` | `ongoing` (can hold several). */
  states: string[]
  /** Archived = muted in Latitude's lifecycle. */
  muted: boolean
  /** Traces/scores grouped into this signal within the time window (the "size"). */
  occurrences: number
  /** Share of sessions touched, in [0, 1]. */
  affectedSessionsPercent: number
  /** Daily buckets for a sparkline, `{ bucket: "YYYY-MM-DD", count }`. */
  trend: Array<{ bucket: string; count: number }>
  tags: string[]
  firstSeenAt: string | null
  lastSeenAt: string | null
  /** `{webBaseUrl}/projects/{slug}/signals/{id}`, or "" when no web URL is set. */
  deepLinkUrl: string
}

export interface ListSignalsParams {
  /** Page size, clamp [1, 200] at the caller. */
  limit?: number
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string | null
  lifecycleGroup?: "active" | "archived"
  sortBy?: "lastSeen" | "occurrences" | "state"
  sortDirection?: "asc" | "desc"
  /** Free-text semantic search over name + description (needs Voyage upstream). */
  query?: string
}

/**
 * Discriminated so the handler can map transport state → a UI status without
 * re-reading HTTP codes. `unauthorized` = bad/missing token; `error` = anything
 * else (network, timeout, 5xx, malformed body). Neither ever throws.
 */
export type ListSignalsOutcome =
  | { kind: "ok"; signals: LatitudeSignalSummary[]; nextCursor: string | null; hasMore: boolean }
  | { kind: "unauthorized" }
  | { kind: "error"; status?: number }

export interface LatitudeReadClient {
  listSignals(params: ListSignalsParams): Promise<ListSignalsOutcome>
}

export interface LatitudeReadClientConfig {
  /** REST API base, e.g. `http://localhost:3011` — NOT the OTLP ingest. */
  apiBaseUrl: string
  /** Web host, e.g. `http://localhost:3000`, for deep links. Absent → no links. */
  webBaseUrl?: string
  /** Bearer secret (the same org API key as the OTLP ingest). */
  token: string
  /** Project slug (path segment). */
  project: string
  /** Per-request timeout (ms). Default 10 000. */
  timeoutMs?: number
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}
function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null
}
function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function mapTrend(v: unknown): Array<{ bucket: string; count: number }> {
  if (!Array.isArray(v)) return []
  return v
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>
      return { bucket: asString(o.bucket), count: asNumber(o.count) }
    })
    .filter((p) => p.bucket)
}

/** `{webBase}/projects/{project}/signals/{id}` — the web route keys by the cuid
 * `id`, NOT the slug (the other REST endpoints use the slug — do not confuse). */
function buildDeepLink(webBase: string | undefined, project: string, id: string): string {
  if (!webBase || !id) return ""
  return `${webBase}/projects/${encodeURIComponent(project)}/signals/${encodeURIComponent(id)}`
}

function mapSignal(
  raw: Record<string, unknown>,
  webBase: string | undefined,
  project: string,
): LatitudeSignalSummary {
  const id = asString(raw.id)
  const slug = asString(raw.slug)
  return {
    id,
    slug,
    name: asString(raw.name) || slug,
    description: asString(raw.description),
    source: asString(raw.source) || "custom",
    states: asStringArray(raw.states),
    muted: raw.mutedAt != null,
    occurrences: asNumber(raw.occurrences),
    affectedSessionsPercent: asNumber(raw.affectedSessionsPercent),
    trend: mapTrend(raw.trend),
    tags: asStringArray(raw.tags),
    firstSeenAt: asStringOrNull(raw.firstSeenAt),
    lastSeenAt: asStringOrNull(raw.lastSeenAt),
    deepLinkUrl: buildDeepLink(webBase, project, id),
  }
}

/** Pure: raw `{ items, nextCursor, hasMore }` page → the Teros DTO outcome. */
export function mapSignalsPage(
  body: unknown,
  webBase: string | undefined,
  project: string,
): ListSignalsOutcome {
  const b = (body ?? {}) as { items?: unknown; nextCursor?: unknown; hasMore?: unknown }
  const items = Array.isArray(b.items) ? b.items : []
  return {
    kind: "ok",
    signals: items.map((it) => mapSignal((it ?? {}) as Record<string, unknown>, webBase, project)),
    nextCursor: typeof b.nextCursor === "string" ? b.nextCursor : null,
    hasMore: b.hasMore === true,
  }
}

/** Pure: `ListSignalsParams` → the query string the REST endpoint expects. Only
 * whitelisted, already-validated keys are forwarded (verified param names). */
export function buildSignalsQuery(params: ListSignalsParams): string {
  const qs = new URLSearchParams()
  if (params.limit != null) qs.set("limit", String(params.limit))
  if (params.cursor) qs.set("cursor", params.cursor)
  if (params.lifecycleGroup) qs.set("lifecycleGroup", params.lifecycleGroup)
  if (params.sortBy) qs.set("sortBy", params.sortBy)
  if (params.sortDirection) qs.set("sortDirection", params.sortDirection)
  if (params.query) qs.set("query", params.query)
  return qs.toString()
}

/**
 * Real transport. Pure factory (reads no env) so it is unit-testable against a
 * fake endpoint. The `fetch` here is the only network call in C2 — the
 * sovereignty grep-guard allowlists this module to its seam + wiring only.
 */
export function createLatitudeReadClient(config: LatitudeReadClientConfig): LatitudeReadClient {
  const apiBase = config.apiBaseUrl.replace(/\/+$/, "")
  const webBase = config.webBaseUrl?.replace(/\/+$/, "")
  const timeoutMs = config.timeoutMs ?? 10_000
  const signalsUrl = `${apiBase}/v1/projects/${encodeURIComponent(config.project)}/signals`

  return {
    async listSignals(params: ListSignalsParams): Promise<ListSignalsOutcome> {
      const query = buildSignalsQuery(params)
      const url = query ? `${signalsUrl}?${query}` : signalsUrl

      let res: Response
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch {
        return { kind: "error" }
      }

      if (res.status === 401 || res.status === 403) return { kind: "unauthorized" }
      if (!res.ok) return { kind: "error", status: res.status }

      let body: unknown
      try {
        body = await res.json()
      } catch {
        return { kind: "error", status: res.status }
      }
      return mapSignalsPage(body, webBase, config.project)
    },
  }
}
