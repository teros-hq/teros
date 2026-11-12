/**
 * Costs API — inference-cost aggregations for the external panel (task_4b1fe21d28b84452).
 *
 * Read-only GET endpoints over `agent_usage_sessions` implementing the exact
 * segmentation validated to the cent in the sep/oct cost reports
 * (skill `informe-costes-inferencia`, reference script /tmp/usage-oct-unified.js v3):
 *
 *   GET /api/costs/overview?from=&to=          — totals per segment
 *   GET /api/costs/weekly?from=&to=            — per ISO week (%G-W%V) × segment
 *   GET /api/costs/by-user?from=&to=&seg=      — per userId (+ email, cost p50/p90/max)
 *   GET /api/costs/by-model?from=&to=&seg=     — per provider × modelId
 *   GET /api/costs/triggers?from=&to=&seg=      — per triggerKind × segment
 *
 * Segmentation (5 segments, Pablo's decision 2026-10-27 — resolved at query time
 * because billing is LIVE: users change plans constantly):
 *   - dev         = userId 'user_0000000000000000' (all of RAW is dev)
 *   - team        = fixed Hexagon member ids (checked BEFORE subscribers —
 *                   Álvaro/Marianne/Rubén have comped plans → would fall in
 *                   friend; Magüi has no plan → would fall in free)
 *   - subscribers = billing_subscriptions status=active, PAID_PLANS, customPrice null/undefined
 *   - friend      = comped paid plans (customPrice === 0)
 *   - free        = plan_seed or no active subscription
 *
 * Cap-30min artifact (OBLIGATORY on every endpoint returning durations):
 * thousands of sessions are recorded with durationMs in [1_795_000–1_805_000] ms
 * — the 30:00 recording ceiling, NOT real work (~74% of raw agent-hours in oct).
 * Every endpoint returns durMsRaw AND durMsAdjusted (adjusted excludes capped
 * sessions) + cappedSessions count. Cost in $ is NOT affected (it comes from
 * tokens). Root cause: task_468fc1515461ab37. New rows carry `durationCapped: true`
 * (cef54a53e); the legacy range remains the fallback for pre-flag rows.
 *
 * Mongo 7 gotchas baked in (all hit in the validated reports):
 *   - $group totals need `_id: null`
 *   - large sums need `$sum: { $toDouble: "$field" }` (Int64 overflow)
 *   - `$percentile` returns an array — unwrapped here
 *   - emails live in `users.profile.email` (NOT users.email)
 *   - agent-hours = durMs / 3.6e6 (NEVER /1e6 — real bug in the v1 report)
 *
 * Auth: `X-API-Key: <key>` — static per-environment API key (NOT Bearer).
 * Key source: `.secrets/system/costs.json` → `{ "apiKey": "..." }` (house
 * secret pattern), falling back to `COSTS_API_KEY` env var. One key per
 * environment (raw / prod). Rotable without a code deploy: edit the secret
 * or env + restart the backend (Pablo manages restarts). Scope: the key
 * authorizes EXACTLY these read-only GET endpoints — any other path carrying
 * it gets a generic 403 at the edge (checkApiKeyScope in services/costs-auth).
 * Missing/invalid key → 401 (identical bodies, no oracle). No key configured
 * → the surface is disabled (404). Every request is audited to
 * costs_access_logs + a pino line, and rate-limited per key (60/min default).
 * The Railway BFF calls with the key server-side; nginx stays as
 * defense-in-depth. Full contract: docs/development/costs-api.md.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Db } from "mongodb"
import { EXCLUDE_DEMO_SEED } from "../services/agent-usage-demo-filter.js"
import { extractClientIp } from "../lib/http-security.js"
import {
  apiKeyMatches,
  costsAccessLogger,
  CostsKeyRateLimiter,
  extractApiKey,
  extractUserAgent,
  keyFingerprint,
  parseRateLimitPerMin,
  resolveCostsEnv,
  type CostsAccessOutcome,
} from "../services/costs-auth.js"

// ---------------------------------------------------------------------------
// Segment constants (configurable via env — Pablo's 27-oct decision)
// ---------------------------------------------------------------------------

/** The dev user — everything on RAW, the platform dev user on prod. */
const DEV_USER_ID = "user_0000000000000000"

/**
 * Hexagon team members. Checked BEFORE subscribers: Álvaro/Marianne/Rubén have
 * comped plans (→ friend) and Magüi has no plan (→ free); they must land in
 * `team` regardless of billing state.
 */
const TEAM_USER_IDS: string[] = (
  process.env.COSTS_TEAM_USER_IDS ||
  "user_3512cd2ba0dc8885,user_a21979d06a2e7ce7,user_c1e251131f644617,user_b33a5ba5b248c7b8"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)

/** Paid plans that make an active subscriber a `subscribers` row. */
const PAID_PLANS = new Set(
  (process.env.COSTS_PAID_PLANS || "plan_growth,plan_pro,plan_ultra,plan_enterprise,plan_starter")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)

export const SEGMENTS = ["dev", "team", "subscribers", "friend", "free"] as const
export type Segment = (typeof SEGMENTS)[number]

// ---------------------------------------------------------------------------
// Cap-30min constants
// ---------------------------------------------------------------------------

/** Legacy recording-ceiling range (ms) — 30:00 ± 5s. Pre-`durationCapped` rows. */
const CAP_RANGE_MIN_MS = 1_795_000
const CAP_RANGE_MAX_MS = 1_805_000

/** ms → agent-hours divisor. 3.6e6 — NEVER 1e6 (v1 report bug). */
const MS_PER_HOUR = 3_600_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostsRange {
  from: Date
  to: Date
}

export interface SegmentResolution {
  /** userId → segment map for every userId seen in the window (plus billing-known ids). */
  userSegments: Map<string, Segment>
  /** Counts of the billing snapshot, for the response meta. */
  billingCounts: { subscribers: number; friend: number; free: number }
}

export interface SegmentTotals {
  segment: Segment
  sessions: number
  costUsd: number
  durMsRaw: number
  durMsAdjusted: number
  hoursRaw: number
  hoursAdjusted: number
  usdHourRaw: number | null
  usdHourAdjusted: number | null
  inputTokens: number
  cachedReadTokens: number
  outputTokens: number
  cacheRatio: number | null
  nUsers: number
  nAgents: number
  ttftP50: number | null
  cappedSessions: number
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Parse the from/to query params. Defaults to the current calendar month
 * (UTC): from = 1st of month 00:00Z, to = now. `to` is EXCLUSIVE in the Mongo
 * filter ($lt), matching the validated reports.
 */
export function parseCostsRange(fromRaw: string | null, toRaw: string | null): CostsRange {
  const now = new Date()
  let from: Date
  let to: Date

  if (fromRaw) {
    const parsed = new Date(fromRaw)
    if (Number.isNaN(parsed.getTime())) throw new Error(`invalid 'from' (ISO 8601 expected): ${fromRaw}`)
    from = parsed
  } else {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  }

  if (toRaw) {
    const parsed = new Date(toRaw)
    if (Number.isNaN(parsed.getTime())) throw new Error(`invalid 'to' (ISO 8601 expected): ${toRaw}`)
    to = parsed
  } else {
    to = now
  }

  if (from >= to) throw new Error("'from' must be < 'to'")
  return { from, to }
}

// ---------------------------------------------------------------------------
// Segmentation — resolved at query time (billing is LIVE)
// ---------------------------------------------------------------------------

interface BillingSubscription {
  userId: string
  planId: string
  status: string
  customPrice: number | null
}

/**
 * Resolve the segment of every relevant user, porting the exact logic of
 * /tmp/usage-oct-unified.js v3 (validated to the cent):
 *
 *   1. dev user → dev
 *   2. team member → team          (BEFORE subscribers — see file docblock)
 *   3. active sub + PAID_PLANS + customPrice null/undefined → subscribers
 *   4. active sub + PAID_PLANS + effective customPrice === 0 → friend
 *   5. everything else (plan_seed, no sub, unknown plan) → free
 *
 * The map is seeded with dev + team ids so users with zero sessions in the
 * window still resolve. `billingCounts` reports the snapshot composition.
 */
export async function resolveSegments(db: Db): Promise<SegmentResolution> {
  const userSegments = new Map<string, Segment>()
  userSegments.set(DEV_USER_ID, "dev")
  for (const id of TEAM_USER_IDS) userSegments.set(id, "team")

  const billingCounts = { subscribers: 0, friend: 0, free: 0 }

  const subs = await db
    .collection<BillingSubscription>("billing_subscriptions")
    .find({ status: "active" }, { projection: { userId: 1, planId: 1, status: 1, customPrice: 1 } })
    .toArray()

  for (const sub of subs) {
    const uid = sub.userId
    // dev/team membership wins over any billing state
    if (userSegments.get(uid) === "dev" || userSegments.get(uid) === "team") continue

    let seg: Segment
    if (PAID_PLANS.has(sub.planId)) {
      // Effective price: null/undefined → real paid plan; 0 → comped (friend)
      const eff =
        sub.customPrice === null || sub.customPrice === undefined
          ? 1
          : Number(sub.customPrice) || 0
      seg = eff > 0 ? "subscribers" : "friend"
    } else {
      // plan_seed or any non-paid plan (incl. the internal unlimited plan)
      seg = "free"
    }

    userSegments.set(uid, seg)
    if (seg === "subscribers") billingCounts.subscribers++
    else if (seg === "friend") billingCounts.friend++
    else billingCounts.free++
  }

  return { userSegments, billingCounts }
}

/**
 * `$addFields` stage assigning `seg` to each session row. Port of segStage()
 * from the reference script — the $switch branch order is load-bearing
 * (dev → team → subscribers → friend, default free).
 */
export function segmentStage(resolution: SegmentResolution): object {
  const { userSegments } = resolution
  const subscribers: string[] = []
  const friend: string[] = []
  for (const [uid, seg] of userSegments) {
    if (seg === "subscribers") subscribers.push(uid)
    else if (seg === "friend") friend.push(uid)
  }
  return {
    $addFields: {
      seg: {
        $switch: {
          branches: [
            { case: { $eq: ["$userId", DEV_USER_ID] }, then: "dev" },
            { case: { $in: ["$userId", TEAM_USER_IDS] }, then: "team" },
            { case: { $in: ["$userId", subscribers] }, then: "subscribers" },
            { case: { $in: ["$userId", friend] }, then: "friend" },
          ],
          default: "free",
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

/** $toDouble wrapper — Int64 overflow guard for large sums. */
function D(field: string): object {
  return { $toDouble: `$${field}` }
}

/**
 * Capped-session predicate: `durationCapped === true` (new rows) OR the legacy
 * [1_795_000–1_805_000] range (pre-flag rows). Used both in the pipeline
 * ($expr-friendly shape) and mirrored in TypeScript for row-level checks.
 */
export const CAPPED_PREDICATE = {
  $or: [
    { $eq: ["$durationCapped", true] },
    {
      $and: [
        { $ne: ["$durationMs", null] },
        { $gte: ["$durationMs", CAP_RANGE_MIN_MS] },
        { $lte: ["$durationMs", CAP_RANGE_MAX_MS] },
      ],
    },
  ],
}

/** TypeScript mirror of CAPPED_PREDICATE for plain session rows. */
export function isCappedSession(row: { durationCapped?: boolean; durationMs?: number | null }): boolean {
  if (row.durationCapped === true) return true
  const d = row.durationMs
  return d != null && d >= CAP_RANGE_MIN_MS && d <= CAP_RANGE_MAX_MS
}

/** hours = durMs / 3.6e6 — the ONLY correct divisor (v1 report bug: /1e6). */
export function msToHours(ms: number): number {
  return ms / MS_PER_HOUR
}

/** usd/hour, null when hours are 0 (no misleading Infinity/NaN). */
function usdPerHour(costUsd: number, hours: number): number | null {
  if (hours <= 0) return null
  return costUsd / hours
}

/** cachedRead / input, null when input is 0. */
function cacheRatio(input: number, cached: number): number | null {
  if (input <= 0) return null
  return cached / input
}

/** Unpack $percentile's array result → number | null. */
function unpackPercentile(value: unknown): number | null {
  if (Array.isArray(value)) {
    const first = value[0]
    return typeof first === "number" && Number.isFinite(first) ? first : null
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  return null
}

/** Round to 2 decimals (money) keeping null as null. */
function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100
}

// ---------------------------------------------------------------------------
// Base pipeline fragments
// ---------------------------------------------------------------------------

interface SessionRow {
  seg: string
  userId: string
  agentId: string
  provider: string
  modelId: string
  triggerKind: string
  startedAt: Date
  durationMs: number | null
  durationCapped?: boolean
  costUsd: number
  inputTokens: number
  cachedReadTokens: number
  outputTokens: number
  ttftMs?: number | null
}

function baseMatch(range: CostsRange): object {
  return { $match: { startedAt: { $gte: range.from, $lt: range.to }, ...EXCLUDE_DEMO_SEED } }
}

/**
 * Fetch the raw session rows for the window and compute everything in
 * TypeScript. 46k sessions (a full prod month) is a few MB in memory — fine
 * for a read-only reporting endpoint, and it keeps the exact validated
 * arithmetic (percentiles, adjusted durations, per-user p50/p90/max) in one
 * auditable place instead of a maze of $group stages.
 */
async function fetchSessionRows(
  db: Db,
  range: CostsRange,
  segFilter: Segment | "all",
  resolution: SegmentResolution,
): Promise<SessionRow[]> {
  const segStageObj = segmentStage(resolution)
  const pipeline: object[] = [baseMatch(range), segStageObj]
  if (segFilter !== "all") {
    pipeline.push({ $match: { seg: segFilter } })
  }
  pipeline.push({
    $project: {
      seg: 1, userId: 1, agentId: 1, provider: 1, modelId: 1, triggerKind: 1,
      startedAt: 1, durationMs: 1, durationCapped: 1, costUsd: 1,
      inputTokens: 1, cachedReadTokens: 1, outputTokens: 1, ttftMs: 1,
    },
  })
  return db.collection("agent_usage_sessions").aggregate<SessionRow>(pipeline).toArray()
}

// ---------------------------------------------------------------------------
// Totals computation (shared by overview & weekly)
// ---------------------------------------------------------------------------

export interface TotalsInput {
  sessions: number
  costUsd: number
  durMsRaw: number
  durMsAdjusted: number
  cappedSessions: number
  inputTokens: number
  cachedReadTokens: number
  outputTokens: number
  users: Set<string>
  agents: Set<string>
  ttfts: number[]
}

export function emptyTotals(): TotalsInput {
  return {
    sessions: 0, costUsd: 0, durMsRaw: 0, durMsAdjusted: 0, cappedSessions: 0,
    inputTokens: 0, cachedReadTokens: 0, outputTokens: 0,
    users: new Set(), agents: new Set(), ttfts: [],
  }
}

export function accumulateRow(t: TotalsInput, row: SessionRow): void {
  t.sessions++
  t.costUsd += Number(row.costUsd) || 0
  const dur = row.durationMs == null ? 0 : Number(row.durationMs) || 0
  t.durMsRaw += dur
  if (isCappedSession(row)) {
    t.cappedSessions++
  } else {
    t.durMsAdjusted += dur
  }
  t.inputTokens += Number(row.inputTokens) || 0
  t.cachedReadTokens += Number(row.cachedReadTokens) || 0
  t.outputTokens += Number(row.outputTokens) || 0
  t.users.add(row.userId)
  t.agents.add(row.agentId)
  if (typeof row.ttftMs === "number" && Number.isFinite(row.ttftMs)) t.ttfts.push(row.ttftMs)
}

export function finalizeTotals(segment: Segment, t: TotalsInput): SegmentTotals {
  const hoursRaw = msToHours(t.durMsRaw)
  const hoursAdjusted = msToHours(t.durMsAdjusted)
  const ttfts = t.ttfts.length ? [...t.ttfts].sort((a, b) => a - b) : []
  const ttftP50 = ttfts.length ? ttfts[Math.floor((ttfts.length - 1) / 2)] : null
  return {
    segment,
    sessions: t.sessions,
    costUsd: round2(t.costUsd) ?? 0,
    durMsRaw: Math.round(t.durMsRaw),
    durMsAdjusted: Math.round(t.durMsAdjusted),
    hoursRaw: Math.round(hoursRaw * 100) / 100,
    hoursAdjusted: Math.round(hoursAdjusted * 100) / 100,
    usdHourRaw: round2(usdPerHour(t.costUsd, hoursRaw)),
    usdHourAdjusted: round2(usdPerHour(t.costUsd, hoursAdjusted)),
    inputTokens: t.inputTokens,
    cachedReadTokens: t.cachedReadTokens,
    outputTokens: t.outputTokens,
    cacheRatio: cacheRatio(t.inputTokens, t.cachedReadTokens),
    nUsers: t.users.size,
    nAgents: t.agents.size,
    ttftP50,
    cappedSessions: t.cappedSessions,
  }
}

/** ISO week key (%G-W%V) — same format as the validated reports. */
export function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** Exact pXX of a sorted-ascending array (nearest-rank, matches report spot checks). */
export function percentileOf(sortedAsc: number[], p: number): number | null {
  if (!sortedAsc.length) return null
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

// ---------------------------------------------------------------------------
// Public query functions (one per endpoint)
// ---------------------------------------------------------------------------

export interface CostsMeta {
  from: string
  to: string
  generatedAt: string
  billingSnapshot: { subscribers: number; friend: number; free: number; team: number; dev: number }
  note: string
}

function buildMeta(range: CostsRange, resolution: SegmentResolution): CostsMeta {
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    generatedAt: new Date().toISOString(),
    billingSnapshot: {
      subscribers: resolution.billingCounts.subscribers,
      friend: resolution.billingCounts.friend,
      free: resolution.billingCounts.free,
      team: TEAM_USER_IDS.length,
      dev: 1,
    },
    note: "durMsAdjusted excludes sessions capped at the 30-min recording ceiling (durationCapped or durationMs in [1795000,1805000] ms) — raw hours are a lower bound on $/hour, adjusted are an upper bound. Cost in $ is unaffected (token-based). Segments resolved at query time (billing is live).",
  }
}

/** GET /api/costs/overview — totals per segment + reconciliation total. */
export async function costsOverview(db: Db, range: CostsRange): Promise<object> {
  const resolution = await resolveSegments(db)
  const rows = await fetchSessionRows(db, range, "all", resolution)

  const bySeg = new Map<string, TotalsInput>()
  for (const row of rows) {
    let t = bySeg.get(row.seg)
    if (!t) {
      t = emptyTotals()
      bySeg.set(row.seg, t)
    }
    accumulateRow(t, row)
  }

  const segments = SEGMENTS.map((seg) => {
    const t = bySeg.get(seg)
    return t ? finalizeTotals(seg, t) : finalizeTotals(seg, emptyTotals())
  })

  // Reconciliation: sum of segments must equal the total to the cent.
  const totalCost = segments.reduce((acc, s) => acc + (s.costUsd ?? 0), 0)
  const totalSessions = segments.reduce((acc, s) => acc + s.sessions, 0)
  const totalDurMsRaw = segments.reduce((acc, s) => acc + s.durMsRaw, 0)
  const totalDurMsAdjusted = segments.reduce((acc, s) => acc + s.durMsAdjusted, 0)
  const totalCapped = segments.reduce((acc, s) => acc + s.cappedSessions, 0)

  return {
    meta: buildMeta(range, resolution),
    segments,
    total: {
      sessions: totalSessions,
      costUsd: round2(totalCost),
      durMsRaw: totalDurMsRaw,
      durMsAdjusted: totalDurMsAdjusted,
      hoursRaw: Math.round(msToHours(totalDurMsRaw) * 100) / 100,
      hoursAdjusted: Math.round(msToHours(totalDurMsAdjusted) * 100) / 100,
      cappedSessions: totalCapped,
    },
  }
}

/** GET /api/costs/weekly — per ISO week × segment. */
export async function costsWeekly(db: Db, range: CostsRange): Promise<object> {
  const resolution = await resolveSegments(db)
  const rows = await fetchSessionRows(db, range, "all", resolution)

  // key: `${week}|${seg}`
  const buckets = new Map<string, TotalsInput & { week: string }>()
  for (const row of rows) {
    const week = isoWeekKey(row.startedAt)
    const key = `${week}|${row.seg}`
    let t = buckets.get(key)
    if (!t) {
      t = { ...emptyTotals(), week }
      buckets.set(key, t)
    }
    accumulateRow(t, row)
  }

  const weeks = [...new Set([...buckets.values()].map((b) => b.week))].sort()
  const result: object[] = []
  for (const week of weeks) {
    for (const seg of SEGMENTS) {
      const t = buckets.get(`${week}|${seg}`)
      if (!t) continue // omit empty segment×week cells (panel-friendly)
      const totals = finalizeTotals(seg, t)
      result.push({ week, ...totals })
    }
  }

  return { meta: buildMeta(range, resolution), weeks: result }
}

/** GET /api/costs/by-user — per userId with email + cost p50/p90/max per account. */
export async function costsByUser(db: Db, range: CostsRange, segFilter: Segment | "all"): Promise<object> {
  const resolution = await resolveSegments(db)
  const rows = await fetchSessionRows(db, range, segFilter, resolution)

  interface UserBucket {
    userId: string
    seg: string
    sessions: number
    costUsd: number
    durMsRaw: number
    durMsAdjusted: number
    cappedSessions: number
    costs: number[]
  }
  const byUser = new Map<string, UserBucket>()
  for (const row of rows) {
    let b = byUser.get(row.userId)
    if (!b) {
      b = {
        userId: row.userId, seg: row.seg, sessions: 0, costUsd: 0,
        durMsRaw: 0, durMsAdjusted: 0, cappedSessions: 0, costs: [],
      }
      byUser.set(row.userId, b)
    }
    b.sessions++
    const cost = Number(row.costUsd) || 0
    b.costUsd += cost
    b.costs.push(cost)
    const dur = row.durationMs == null ? 0 : Number(row.durationMs) || 0
    b.durMsRaw += dur
    if (isCappedSession(row)) b.cappedSessions++
    else b.durMsAdjusted += dur
  }

  // Email lookup — users.profile.email (NOT users.email). Lookup by userId field.
  const userIds = [...byUser.keys()]
  const userDocs = userIds.length
    ? await db
        .collection("users")
        .find({ userId: { $in: userIds } }, { projection: { userId: 1, "profile.email": 1, name: 1, fullName: 1 } })
        .toArray()
    : []
  const emailMap = new Map<string, string | null>()
  for (const doc of userDocs as { userId?: string; profile?: { email?: string } }[]) {
    if (doc.userId) emailMap.set(doc.userId, doc.profile?.email ?? null)
  }

  const users = [...byUser.values()]
    .map((b) => {
      const sortedCosts = [...b.costs].sort((a, z) => a - z)
      return {
        userId: b.userId,
        segment: b.seg,
        email: emailMap.get(b.userId) ?? null,
        sessions: b.sessions,
        costUsd: round2(b.costUsd),
        durMsRaw: Math.round(b.durMsRaw),
        durMsAdjusted: Math.round(b.durMsAdjusted),
        hoursRaw: Math.round(msToHours(b.durMsRaw) * 100) / 100,
        hoursAdjusted: Math.round(msToHours(b.durMsAdjusted) * 100) / 100,
        costP50: round2(percentileOf(sortedCosts, 50)),
        costP90: round2(percentileOf(sortedCosts, 90)),
        costMax: round2(sortedCosts.length ? sortedCosts[sortedCosts.length - 1] : null),
        cappedSessions: b.cappedSessions,
      }
    })
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))

  return { meta: buildMeta(range, resolution), users }
}

/** GET /api/costs/by-model — per provider × modelId. */
export async function costsByModel(db: Db, range: CostsRange, segFilter: Segment | "all"): Promise<object> {
  const resolution = await resolveSegments(db)
  const rows = await fetchSessionRows(db, range, segFilter, resolution)

  interface ModelBucket {
    provider: string
    modelId: string
    sessions: number
    costUsd: number
    inputTokens: number
    cachedReadTokens: number
    outputTokens: number
    durMsRaw: number
    durMsAdjusted: number
    cappedSessions: number
    ttfts: number[]
  }
  const byModel = new Map<string, ModelBucket>()
  for (const row of rows) {
    const key = `${row.provider}|${row.modelId}`
    let b = byModel.get(key)
    if (!b) {
      b = {
        provider: row.provider, modelId: row.modelId, sessions: 0, costUsd: 0,
        inputTokens: 0, cachedReadTokens: 0, outputTokens: 0,
        durMsRaw: 0, durMsAdjusted: 0, cappedSessions: 0, ttfts: [],
      }
      byModel.set(key, b)
    }
    b.sessions++
    b.costUsd += Number(row.costUsd) || 0
    b.inputTokens += Number(row.inputTokens) || 0
    b.cachedReadTokens += Number(row.cachedReadTokens) || 0
    b.outputTokens += Number(row.outputTokens) || 0
    const dur = row.durationMs == null ? 0 : Number(row.durationMs) || 0
    b.durMsRaw += dur
    if (isCappedSession(row)) b.cappedSessions++
    else b.durMsAdjusted += dur
    if (typeof row.ttftMs === "number" && Number.isFinite(row.ttftMs)) b.ttfts.push(row.ttftMs)
  }

  const models = [...byModel.values()]
    .map((b) => {
      const sortedTtfts = [...b.ttfts].sort((a, z) => a - z)
      return {
        provider: b.provider,
        modelId: b.modelId,
        sessions: b.sessions,
        costUsd: round2(b.costUsd),
        inputTokens: b.inputTokens,
        cachedReadTokens: b.cachedReadTokens,
        outputTokens: b.outputTokens,
        cacheRatio: cacheRatio(b.inputTokens, b.cachedReadTokens),
        durMsRaw: Math.round(b.durMsRaw),
        durMsAdjusted: Math.round(b.durMsAdjusted),
        hoursRaw: Math.round(msToHours(b.durMsRaw) * 100) / 100,
        hoursAdjusted: Math.round(msToHours(b.durMsAdjusted) * 100) / 100,
        ttftP50: sortedTtfts.length ? sortedTtfts[Math.floor((sortedTtfts.length - 1) / 2)] : null,
        cappedSessions: b.cappedSessions,
      }
    })
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))

  return { meta: buildMeta(range, resolution), models }
}

/** GET /api/costs/triggers — per triggerKind × segment. */
export async function costsTriggers(db: Db, range: CostsRange, segFilter: Segment | "all"): Promise<object> {
  const resolution = await resolveSegments(db)
  const rows = await fetchSessionRows(db, range, segFilter, resolution)

  interface TriggerBucket {
    triggerKind: string
    seg: string
    sessions: number
    costUsd: number
    durMsRaw: number
    durMsAdjusted: number
    cappedSessions: number
  }
  const byTrigger = new Map<string, TriggerBucket>()
  for (const row of rows) {
    const key = `${row.triggerKind}|${row.seg}`
    let b = byTrigger.get(key)
    if (!b) {
      b = {
        triggerKind: row.triggerKind, seg: row.seg, sessions: 0, costUsd: 0,
        durMsRaw: 0, durMsAdjusted: 0, cappedSessions: 0,
      }
      byTrigger.set(key, b)
    }
    b.sessions++
    b.costUsd += Number(row.costUsd) || 0
    const dur = row.durationMs == null ? 0 : Number(row.durationMs) || 0
    b.durMsRaw += dur
    if (isCappedSession(row)) b.cappedSessions++
    else b.durMsAdjusted += dur
  }

  const triggers = [...byTrigger.values()]
    .map((b) => ({
      triggerKind: b.triggerKind,
      segment: b.seg,
      sessions: b.sessions,
      costUsd: round2(b.costUsd),
      durMsRaw: Math.round(b.durMsRaw),
      durMsAdjusted: Math.round(b.durMsAdjusted),
      hoursRaw: Math.round(msToHours(b.durMsRaw) * 100) / 100,
      hoursAdjusted: Math.round(msToHours(b.durMsAdjusted) * 100) / 100,
      cappedSessions: b.cappedSessions,
    }))
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))

  return { meta: buildMeta(range, resolution), triggers }
}

// ---------------------------------------------------------------------------
// HTTP route factory
// ---------------------------------------------------------------------------

export interface CostsRoutesConfig {
  db: Db
  /**
   * Static per-environment API key (X-API-Key). When null the routes are
   * disabled (404) — safer default; cross-tenant financial data is never
   * exposed open. Resolved in server-bootstrap from the costs secret / env.
   */
  apiKey: string | null
  /** Environment label written to every access-log entry (raw | prod | …). */
  env: string
  /** Requests per minute per key (0 disables). Default 60. */
  rateLimitPerMin?: number
  /** Trust X-Forwarded-For for the access-log IP (set behind nginx). */
  trustProxy?: boolean
  /** Test seam: clock for the rate limiter. */
  now?: () => number
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders })
  res.end(JSON.stringify(data))
}

/**
 * Create the /api/costs/* HTTP route handler. Returns `true` when the request
 * was handled.
 *
 * Auth: `X-API-Key: <key>` (timing-safe compare, see services/costs-auth).
 * Every request — served or rejected — is audited to `costs_access_logs`
 * (timestamp, endpoint, from/to, seg, env, ip, userAgent, outcome, status,
 * key fingerprint; never the key itself) plus a pino line, and counted
 * against the per-key rate limit.
 */
export function createCostsRoutes(cfg: CostsRoutesConfig) {
  const { db, apiKey, env, trustProxy = false } = cfg
  const rateLimiter = new CostsKeyRateLimiter(
    cfg.rateLimitPerMin ?? parseRateLimitPerMin(process.env.COSTS_RATE_LIMIT_PER_MIN),
    60_000,
    cfg.now,
  )

  return async function handleCostsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const questionIdx = url.indexOf("?")
    const basePath = questionIdx === -1 ? url : url.slice(0, questionIdx)
    if (!basePath.startsWith("/api/costs/")) return false

    const clientIp = extractClientIp(req, trustProxy)
    const userAgent = extractUserAgent(req)
    const presented = extractApiKey(req)
    const fingerprint = presented != null ? keyFingerprint(presented) : null

    /** Audit one request. Fire-and-forget — never throws (costs-auth). */
    const audit = (
      outcome: CostsAccessOutcome,
      status: number,
      window?: { from?: string | null; to?: string | null; seg?: string | null },
    ): void => {
      costsAccessLogger.log({
        timestamp: new Date(),
        endpoint: basePath,
        from: window?.from ?? null,
        to: window?.to ?? null,
        seg: window?.seg ?? null,
        env,
        ip: clientIp,
        userAgent,
        outcome,
        status,
        keyFingerprint: fingerprint,
      })
    }

    // Disabled when no key is configured — surface nothing rather than open
    // cross-tenant financial data. Generic body: no oracle that the surface
    // exists on this instance.
    if (!apiKey) {
      audit("disabled", 404)
      sendJson(res, 404, { error: "NOT_FOUND", message: "Not Found" })
      return true
    }

    // Auth — X-API-Key, timing-safe. Missing and invalid answer IDENTICALLY:
    // an outsider must not be able to distinguish "no key" from "wrong key",
    // only that a key is required.
    if (presented == null) {
      audit("unauthorized_missing", 401)
      sendJson(res, 401, { error: "UNAUTHORIZED", message: "API key required" })
      return true
    }
    if (!apiKeyMatches(presented, apiKey)) {
      audit("unauthorized_invalid", 401)
      sendJson(res, 401, { error: "UNAUTHORIZED", message: "API key required" })
      return true
    }

    // Rate limit — per key fingerprint, fixed 60s window. The panel refreshes
    // every few hours; anything beyond this is abuse or a bug. (fingerprint is
    // non-null here: presented passed the null check above.)
    const decision = rateLimiter.check(fingerprint ?? keyFingerprint(presented))
    if (!decision.allowed) {
      audit("rate_limited", 429)
      sendJson(
        res,
        429,
        {
          error: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded",
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        { "Retry-After": String(decision.retryAfterSeconds) },
      )
      return true
    }

    if (req.method !== "GET") {
      audit("method_not_allowed", 405)
      sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "Read-only GET endpoints" })
      return true
    }

    // Query params
    const query = questionIdx === -1 ? "" : url.slice(questionIdx + 1)
    const params = new URLSearchParams(query)
    const fromRaw = params.get("from")
    const toRaw = params.get("to")
    const segRaw = params.get("seg")
    // The window as requested (raw strings) — what the audit log records.
    const requestedWindow = { from: fromRaw, to: toRaw, seg: segRaw }

    let range: CostsRange
    try {
      range = parseCostsRange(fromRaw, toRaw)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      audit("bad_request", 400, requestedWindow)
      sendJson(res, 400, { error: "BAD_REQUEST", message })
      return true
    }

    let segFilter: Segment | "all" = "all"
    if (segRaw) {
      if (!(SEGMENTS as readonly string[]).includes(segRaw)) {
        audit("bad_request", 400, requestedWindow)
        sendJson(res, 400, {
          error: "BAD_REQUEST",
          message: `invalid 'seg' — expected one of ${SEGMENTS.join(", ")}`,
        })
        return true
      }
      segFilter = segRaw as Segment
    }

    try {
      switch (basePath) {
        case "/api/costs/overview": {
          const body = await costsOverview(db, range)
          audit("ok", 200, requestedWindow)
          sendJson(res, 200, body)
          return true
        }
        case "/api/costs/weekly": {
          const body = await costsWeekly(db, range)
          audit("ok", 200, requestedWindow)
          sendJson(res, 200, body)
          return true
        }
        case "/api/costs/by-user": {
          const body = await costsByUser(db, range, segFilter)
          audit("ok", 200, requestedWindow)
          sendJson(res, 200, body)
          return true
        }
        case "/api/costs/by-model": {
          const body = await costsByModel(db, range, segFilter)
          audit("ok", 200, requestedWindow)
          sendJson(res, 200, body)
          return true
        }
        case "/api/costs/triggers": {
          const body = await costsTriggers(db, range, segFilter)
          audit("ok", 200, requestedWindow)
          sendJson(res, 200, body)
          return true
        }
        default:
          // Unknown endpoint. Generic body — the endpoint list is not an
          // oracle for a caller that already holds a valid key.
          audit("not_found", 404, requestedWindow)
          sendJson(res, 404, { error: "NOT_FOUND", message: "Not Found" })
          return true
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("[CostsRoutes] aggregation error:", err)
      audit("internal_error", 500, requestedWindow)
      sendJson(res, 500, { error: "INTERNAL_ERROR", message })
      return true
    }
  }
}
