/**
 * Upstream status-page probe (TER-616/§C9, R9).
 *
 * Polls the public Statuspage.io feeds of the teros upstreams (Fireworks,
 * Together) so the model-health window can show an "upstream incident" badge —
 * context that turns "our error-rate spiked" into "…because Fireworks declared a
 * major outage". Fully best-effort: any network/parse failure degrades to
 * `unknown`, never throws, and is cached for a minute so a busy admin window
 * does not hammer the status endpoints.
 *
 * Statuspage.io `/api/v2/status.json` shape: `{ status: { indicator, description } }`
 * where indicator ∈ none | minor | major | critical | maintenance.
 */

export type UpstreamIndicator =
  | "operational"
  | "degraded"
  | "partial_outage"
  | "major_outage"
  | "maintenance"
  | "unknown"

export interface UpstreamStatus {
  fireworks: UpstreamIndicator
  together: UpstreamIndicator
}

const STATUS_ENDPOINTS = {
  fireworks: "https://status.fireworks.ai/api/v2/status.json",
  together: "https://status.together.ai/api/v2/status.json",
} as const

const TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 3_000

/** Map a Statuspage.io indicator to our health enum. Pure + unit-testable. */
export function mapStatuspageIndicator(indicator: unknown): UpstreamIndicator {
  switch (indicator) {
    case "none":
      return "operational"
    case "minor":
      return "degraded"
    case "major":
      return "partial_outage"
    case "critical":
      return "major_outage"
    case "maintenance":
      return "maintenance"
    default:
      return "unknown"
  }
}

async function fetchOne(url: string): Promise<UpstreamIndicator> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) return "unknown"
      const body = (await res.json()) as { status?: { indicator?: string } }
      return mapStatuspageIndicator(body?.status?.indicator)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // Network error, timeout, non-JSON body — degrade silently.
    return "unknown"
  }
}

let cache: { at: number; value: UpstreamStatus } | null = null

/**
 * Current upstream status, cached for {@link TTL_MS}. `now` is injectable for
 * tests; production passes the default. Never rejects.
 */
export async function getUpstreamStatus(now: number = Date.now()): Promise<UpstreamStatus> {
  if (cache && now - cache.at < TTL_MS) return cache.value
  const [fireworks, together] = await Promise.all([
    fetchOne(STATUS_ENDPOINTS.fireworks),
    fetchOne(STATUS_ENDPOINTS.together),
  ])
  const value: UpstreamStatus = { fireworks, together }
  cache = { at: now, value }
  return value
}

/** Test seam: drop the cached status so the next call refetches. */
export function __resetUpstreamStatusCache(): void {
  cache = null
}
