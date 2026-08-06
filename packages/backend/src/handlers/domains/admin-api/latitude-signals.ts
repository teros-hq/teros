/**
 * admin-api.latitude-signals-list — browse Latitude's clustered-failure signals
 * inside Teros (F4 · C2, system admin).
 *
 * The signals dashboard read path. Delegates to the one vendor seam
 * (`latitude-read-client`) and returns DATA, never UI strings — the frontend
 * composes the phrasing. `status` discriminates the four outcomes so the UI can
 * tell "not configured" from "unreachable" from "empty":
 *
 *   unconfigured — no read client wired (LATITUDE_API_URL/TOKEN/PROJECT unset).
 *   unauthorized — Latitude rejected the token.
 *   unreachable  — Latitude down / network / 5xx / malformed (never throws here).
 *   ok           — a page of signals (possibly empty).
 *
 * Soberanía: this is a disposable read. Latitude down degrades to `unreachable`;
 * no product decision reads a signal. Auth (requireSystemAdmin) is the only thing
 * that throws — an admin-gate failure is not a Latitude problem.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import type { LatitudeReadClient, ListSignalsParams } from "../../../services/latitude-read-client"

const LIFECYCLE_GROUPS = new Set(["active", "archived"])
const SORT_FIELDS = new Set(["lastSeen", "occurrences", "state"])
const SORT_DIRECTIONS = new Set(["asc", "desc"])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_QUERY_LEN = 500

/**
 * Boundary validation for what JSON Schema can't express here: clamp `limit` to
 * the endpoint's [1, 200], whitelist the enum params (an unknown value is dropped,
 * never forwarded), and trim + cap the free-text search. `cursor` is an opaque
 * string echoed straight back to Latitude.
 */
export function parseListSignalsParams(rawData: unknown): ListSignalsParams {
  const d = (rawData ?? {}) as Record<string, unknown>
  const params: ListSignalsParams = {}

  const rawLimit = typeof d.limit === "number" && Number.isFinite(d.limit) ? d.limit : DEFAULT_LIMIT
  params.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit)))

  if (typeof d.cursor === "string" && d.cursor) params.cursor = d.cursor
  if (typeof d.lifecycleGroup === "string" && LIFECYCLE_GROUPS.has(d.lifecycleGroup)) {
    params.lifecycleGroup = d.lifecycleGroup as ListSignalsParams["lifecycleGroup"]
  }
  if (typeof d.sortBy === "string" && SORT_FIELDS.has(d.sortBy)) {
    params.sortBy = d.sortBy as ListSignalsParams["sortBy"]
  }
  if (typeof d.sortDirection === "string" && SORT_DIRECTIONS.has(d.sortDirection)) {
    params.sortDirection = d.sortDirection as ListSignalsParams["sortDirection"]
  }
  if (typeof d.query === "string") {
    const q = d.query.trim()
    if (q) params.query = q.slice(0, MAX_QUERY_LEN)
  }
  return params
}

export function createLatitudeSignalsListHandler(db: Db, readClient?: LatitudeReadClient | null) {
  return async function latitudeSignalsList(ctx: WsHandlerContext, rawData: unknown) {
    await requireSystemAdmin(db, ctx.userId)

    if (!readClient) {
      return { status: "unconfigured" as const, signals: [], nextCursor: null, hasMore: false }
    }

    const params = parseListSignalsParams(rawData)
    const outcome = await readClient.listSignals(params)

    if (outcome.kind === "unauthorized") {
      return { status: "unauthorized" as const, signals: [], nextCursor: null, hasMore: false }
    }
    if (outcome.kind === "error") {
      return { status: "unreachable" as const, signals: [], nextCursor: null, hasMore: false }
    }
    return {
      status: "ok" as const,
      signals: outcome.signals,
      nextCursor: outcome.nextCursor,
      hasMore: outcome.hasMore,
    }
  }
}
