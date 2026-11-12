/**
 * Unit tests for the Costs API (task_4b1fe21d28b84452) — the read-only
 * inference-cost aggregations behind /api/costs/*.
 *
 * What is asserted (each maps to a validated-report invariant):
 *  - Segment reconciliation: dev+team+subscribers+friend+free = total to the
 *    cent, session counts and durations included (the cuadre rule).
 *  - Segmentation precedence: team BEFORE subscribers — Álvaro/Marianne/Rubén
 *    (comped paid plans) must land in `team`, not `friend`; Magüi (no plan)
 *    must land in `team`, not `free`.
 *  - Cap-30min: durMsRaw includes capped sessions, durMsAdjusted excludes
 *    them, cappedSessions counts them; both the `durationCapped` flag and the
 *    legacy [1_795_000–1_805_000] range are detected; cost is unaffected.
 *  - Hours conversion: durMs/3.6e6 (the v1-report /1e6 bug must never return).
 *  - ISO week keys (%G-W%V format, Monday-start).
 *  - Percentiles: p50/p90/max of per-account cost (nearest-rank).
 *  - Emails resolve from users.profile.email (NOT users.email).
 *
 * The fake Db implements the subset of the Mongo driver surface the module
 * uses: collection().find() with projection and collection().aggregate() with
 * the exact pipeline the module builds ($match → $addFields seg → optional
 * $match seg → $project), interpreted in TypeScript.
 */

import { describe, expect, it } from "bun:test"
import {
  CAPPED_PREDICATE,
  SEGMENTS,
  accumulateRow,
  costsByModel,
  costsByUser,
  costsOverview,
  costsTriggers,
  costsWeekly,
  emptyTotals,
  finalizeTotals,
  isCappedSession,
  isoWeekKey,
  msToHours,
  parseCostsRange,
  percentileOf,
  resolveSegments,
  segmentStage,
  type SegmentResolution,
} from "../../src/routes/costs-routes"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEV = "user_0000000000000000"
const ALVARO = "user_3512cd2ba0dc8885" // team, comped plan (would be friend)
const MARIANNE = "user_a21979d06a2e7ce7" // team, comped plan (would be friend)
const RUBEN = "user_c1e251131f644617" // team, comped plan (would be friend)
const MAGUI = "user_b33a5ba5b248c7b8" // team, NO plan (would be free)
const SUBSCRIBER = "user_sub_pro" // active pro, customPrice null
const FRIEND = "user_friend_zero" // active growth, customPrice 0
const FREE_SEED = "user_free_seed" // active plan_seed
const FREE_NOSUB = "user_free_nosub" // no subscription row at all

interface SessionDoc {
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
  outputTokens: number
  cachedReadTokens: number
  ttftMs?: number
  demoSeed?: boolean
}

function session(over: Partial<SessionDoc>): SessionDoc {
  return {
    userId: DEV,
    agentId: "agent_1",
    provider: "teros",
    modelId: "teros-kimi-k2.6",
    triggerKind: "user_message",
    startedAt: new Date("2026-10-14T10:00:00Z"),
    durationMs: 60_000,
    costUsd: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cachedReadTokens: 0,
    ttftMs: 800,
    ...over,
  }
}

interface SubDoc {
  userId: string
  planId: string
  status: string
  customPrice: number | null
}

const SUBS: SubDoc[] = [
  { userId: ALVARO, planId: "plan_pro", status: "active", customPrice: 0 }, // comped → friend if not team
  { userId: MARIANNE, planId: "plan_growth", status: "active", customPrice: 0 },
  { userId: RUBEN, planId: "plan_ultra", status: "active", customPrice: 0 },
  { userId: SUBSCRIBER, planId: "plan_pro", status: "active", customPrice: null },
  { userId: FRIEND, planId: "plan_growth", status: "active", customPrice: 0 },
  { userId: FREE_SEED, planId: "plan_seed", status: "active", customPrice: null },
  { userId: "user_cancelled", planId: "plan_pro", status: "cancelled", customPrice: null }, // not active → free
]

const USERS = [
  { userId: DEV, profile: { email: "pablo@example.agentapps.tech" } },
  { userId: ALVARO, profile: { email: "alvaro@example.agentapps.tech" } },
  { userId: MARIANNE, profile: { email: "marianne@example.agentapps.tech" } },
  { userId: RUBEN, profile: { email: "ruben@example.agentapps.tech" } },
  { userId: MAGUI, profile: { email: "magui@teros.ai" } },
  { userId: SUBSCRIBER, profile: { email: "sub@example.com" } },
  { userId: FRIEND, profile: { email: "friend@example.com" } },
]

// ---------------------------------------------------------------------------
// Fake Db — interprets the exact pipeline the module builds
// ---------------------------------------------------------------------------

/**
 * Minimal Mongo driver mock. `aggregate` runs the module's real pipeline
 * stages: $match (startedAt range + demoSeed) → $addFields seg (via the
 * module's own segmentStage output, interpreted) → optional $match {seg} →
 * $project. Keeping the interpretation aligned with the module's pipeline
 * shape is what makes the tests bite: a dropped stage or a renamed field
 * breaks the fake and the test.
 */
function makeFakeDb(sessionDocs: SessionDoc[]) {
  const aggregateCalls: object[][] = []

  function interpretPipeline(pipeline: object[]): SessionDoc[] {
    let rows: (SessionDoc & { seg?: string })[] = sessionDocs.slice()
    for (const stage of pipeline) {
      const stageObj = stage as Record<string, Record<string, unknown>>
      if ("$match" in stageObj) {
        const m = stageObj.$match as Record<string, unknown>
        rows = rows.filter((row) => {
          const rowAsRecord = row as unknown as Record<string, unknown>
          return Object.entries(m).every(([key, cond]) => {
            if (key === "startedAt") {
              const c = cond as { $gte?: Date; $lt?: Date }
              const v = row.startedAt as unknown as Date
              if (c.$gte && !(v >= c.$gte)) return false
              if (c.$lt && !(v < c.$lt)) return false
              return true
            }
            if (key === "demoSeed") {
              // $ne: true — real docs omit the field
              return rowAsRecord[key] !== true
            }
            if (key === "seg") {
              return row.seg === cond
            }
            return rowAsRecord[key] === cond
          })
        })
      } else if ("$addFields" in stageObj) {
        const fields = stageObj.$addFields as Record<string, unknown>
        if ("seg" in fields) {
          // Interpret the $switch the module emits — same branch order.
          const sw = (fields.seg as Record<string, unknown>).$switch as {
            branches: { case: Record<string, unknown>; then: string }[]
            default: string
          }
          rows = rows.map((row) => {
            for (const branch of sw.branches) {
              if (evalSwitchCase(branch.case, row)) {
                return { ...row, seg: branch.then }
              }
            }
            return { ...row, seg: sw.default }
          })
        }
      } else if ("$project" in stageObj) {
        // The module projects a fixed field list; keep the row as-is (extra
        // fields on the fake docs are harmless — the module only reads these).
      }
    }
    return rows as SessionDoc[]
  }

  // Re-derive the userId→segment map exactly like resolveSegments does, so
  // the $switch interpretation stays in sync with the module's semantics.
  function resolveSegForSwitch(): Map<string, string> {
    // Lazily built from SUBS + constants — mirrors the module under test.
    const map = new Map<string, string>()
    map.set(DEV, "dev")
    const teamIds = (
      process.env.COSTS_TEAM_USER_IDS ||
      "user_3512cd2ba0dc8885,user_a21979d06a2e7ce7,user_c1e251131f644617,user_b33a5ba5b248c7b8"
    ).split(",")
    for (const id of teamIds) map.set(id.trim(), "team")
    const paid = new Set(["plan_growth", "plan_pro", "plan_ultra", "plan_enterprise", "plan_starter"])
    for (const sub of SUBS) {
      if (sub.status !== "active") continue
      if (map.get(sub.userId) === "dev" || map.get(sub.userId) === "team") continue
      let seg: string
      if (paid.has(sub.planId)) {
        const eff = sub.customPrice === null || sub.customPrice === undefined ? 1 : Number(sub.customPrice) || 0
        seg = eff > 0 ? "subscribers" : "friend"
      } else {
        seg = "free"
      }
      map.set(sub.userId, seg)
    }
    return map
  }

  function evalSwitchCase(c: Record<string, unknown>, row: SessionDoc): boolean {
    // The module's cases are $eq: ["$field", literal] and $in: ["$field", list]
    // — the operator value IS the args array, and the field carries Mongo's
    // "$" expression prefix (stripped here).
    const ref = (f: string) => (f.startsWith("$") ? f.slice(1) : f)
    if ("$eq" in c) {
      const [field, literal] = c.$eq as [string, string]
      return (row as unknown as Record<string, string>)[ref(field)] === literal
    }
    if ("$in" in c) {
      const [field, list] = c.$in as [string, string[]]
      const uid = (row as unknown as Record<string, string>)[ref(field)]
      // The module's $in lists contain exactly the userIds of that segment,
      // so membership alone decides.
      return list.includes(uid)
    }
    return false
  }

  const collections: Record<string, unknown> = {
    billing_subscriptions: {
      find: (filter: Record<string, unknown>) => {
        // The module filters { status: "active" } with a projection.
        const rows = (filter.status ? SUBS.filter((s) => s.status === filter.status) : SUBS).map((s) => ({ ...s }))
        return { toArray: async () => rows }
      },
    },
    users: {
      find: (filter: Record<string, unknown>) => {
        const ids = (filter.userId as { $in: string[] }).$in
        const rows = USERS.filter((u) => ids.includes(u.userId)).map((u) => ({ ...u }))
        return { toArray: async () => rows }
      },
    },
    agent_usage_sessions: {
      aggregate: (pipeline: object[]) => {
        aggregateCalls.push(pipeline)
        return { toArray: async () => interpretPipeline(pipeline) }
      },
    },
  }

  return {
    db: { collection: (name: string) => collections[name] } as never,
    aggregateCalls,
  }
}

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

describe("parseCostsRange", () => {
  it("defaults to the current calendar month (UTC), to = now, from < to", () => {
    const before = new Date()
    const r = parseCostsRange(null, null)
    const after = new Date()
    expect(r.from.toISOString()).toBe(new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), 1)).toISOString())
    expect(r.to.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(r.to.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(r.from < r.to).toBe(true)
  })

  it("accepts explicit ISO from/to (to is exclusive)", () => {
    const r = parseCostsRange("2026-10-01T00:00:00Z", "2026-10-28T00:00:00Z")
    expect(r.from.toISOString()).toBe("2026-10-01T00:00:00.000Z")
    expect(r.to.toISOString()).toBe("2026-10-28T00:00:00.000Z")
  })

  it("rejects invalid dates and from >= to", () => {
    expect(() => parseCostsRange("not-a-date", null)).toThrow(/invalid 'from'/)
    expect(() => parseCostsRange(null, "not-a-date")).toThrow(/invalid 'to'/)
    expect(() => parseCostsRange("2026-10-10T00:00:00Z", "2026-10-10T00:00:00Z")).toThrow(/from.*<.*to/)
    expect(() => parseCostsRange("2026-10-11T00:00:00Z", "2026-10-10T00:00:00Z")).toThrow(/from.*<.*to/)
  })
})

describe("msToHours — the 3.6e6 divisor (v1-report bug guard)", () => {
  it("converts ms → agent-hours with durMs/3.6e6, never /1e6", () => {
    expect(msToHours(3_600_000)).toBe(1)
    expect(msToHours(1_800_000)).toBe(0.5)
    expect(msToHours(1_795_000)).toBeCloseTo(0.4986, 3)
    // The /1e6 bug would give 1.8 and 1.795 here — 3.6× off.
    expect(msToHours(1_800_000)).not.toBe(1.8)
  })
})

describe("isCappedSession / CAPPED_PREDICATE — cap-30min detection", () => {
  it("flags durationCapped rows regardless of durationMs", () => {
    expect(isCappedSession({ durationCapped: true, durationMs: 500_000 })).toBe(true)
    expect(isCappedSession({ durationCapped: true, durationMs: null })).toBe(true)
  })

  it("flags the legacy [1_795_000–1_805_000] range (pre-flag rows)", () => {
    expect(isCappedSession({ durationMs: 1_795_000 })).toBe(true)
    expect(isCappedSession({ durationMs: 1_800_000 })).toBe(true)
    expect(isCappedSession({ durationMs: 1_805_000 })).toBe(true)
    expect(isCappedSession({ durationMs: 1_794_999 })).toBe(false)
    expect(isCappedSession({ durationMs: 1_805_001 })).toBe(false)
  })

  it("does not flag normal durations, nulls or missing fields", () => {
    expect(isCappedSession({ durationMs: 60_000 })).toBe(false)
    expect(isCappedSession({ durationMs: 2_400_000 })).toBe(false) // 40 min, above the ceiling
    expect(isCappedSession({ durationMs: null })).toBe(false)
    expect(isCappedSession({})).toBe(false)
    // durationCapped: false does NOT suppress the legacy-range fallback — a
    // pre-flag row in the range is still capped (the flag and the range are
    // independent OR signals, mirroring CAPPED_PREDICATE).
    expect(isCappedSession({ durationCapped: false, durationMs: 1_800_000 })).toBe(true)
    expect(isCappedSession({ durationCapped: false, durationMs: 60_000 })).toBe(false)
  })

  it("exports the $expr-shaped predicate for pipeline use", () => {
    expect(CAPPED_PREDICATE).toHaveProperty("$or")
    expect((CAPPED_PREDICATE as { $or: unknown[] }).$or).toHaveLength(2)
  })
})

describe("isoWeekKey — %G-W%V format", () => {
  it("returns YYYY-Www keys", () => {
    expect(isoWeekKey(new Date("2026-10-14T10:00:00Z"))).toMatch(/^\d{4}-W\d{2}$/)
  })

  it("Monday belongs to the week that starts that Monday", () => {
    // 2026-10-12 is a Monday → week 42 starts there
    expect(isoWeekKey(new Date("2026-10-12T00:00:00Z"))).toBe(isoWeekKey(new Date("2026-10-12T23:59:59Z")))
    // Sunday 2026-10-11 is still the PREVIOUS week (W41) — Sunday is the last day
    expect(isoWeekKey(new Date("2026-10-11T23:00:00Z"))).not.toBe(isoWeekKey(new Date("2026-10-12T01:00:00Z")))
  })

  it("matches the known October 2026 ISO weeks (W40..W44)", () => {
    expect(isoWeekKey(new Date("2026-10-01T12:00:00Z"))).toBe("2026-W40")
    expect(isoWeekKey(new Date("2026-10-05T12:00:00Z"))).toBe("2026-W41")
    expect(isoWeekKey(new Date("2026-10-26T12:00:00Z"))).toBe("2026-W44")
  })

  it("handles the year boundary (Jan 1 can be W52/W53 of the previous year)", () => {
    // 2027-01-01 is a Friday → ISO week 53 of 2026
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53")
  })
})

describe("percentileOf — nearest-rank p50/p90", () => {
  it("computes p50 of a sorted array (nearest-rank)", () => {
    expect(percentileOf([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentileOf([1, 2, 3, 4], 50)).toBe(2) // ceil(0.5*4)=2 → idx 1
  })

  it("computes p90 of the report's spot-check example", () => {
    // 10 values: p90 = the 9th (nearest-rank)
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9)
  })

  it("returns null on empty input and clamps out-of-range p", () => {
    expect(percentileOf([], 50)).toBe(null)
    expect(percentileOf([5], 0)).toBe(5)
    expect(percentileOf([5], 100)).toBe(5)
  })
})

describe("resolveSegments — billing precedence (validated v3 logic)", () => {
  async function makeDb() {
    return makeFakeDb([]).db
  }

  it("maps every billing shape to the right segment", async () => {
    const resolution = await resolveSegments(await makeDb())
    const m = resolution.userSegments
    expect(m.get(DEV)).toBe("dev")
    // team wins over billing — the load-bearing precedence
    expect(m.get(ALVARO)).toBe("team")
    expect(m.get(MARIANNE)).toBe("team")
    expect(m.get(RUBEN)).toBe("team")
    expect(m.get(MAGUI)).toBe("team") // no plan at all, still team
    // billing shapes
    expect(m.get(SUBSCRIBER)).toBe("subscribers")
    expect(m.get(FRIEND)).toBe("friend")
    expect(m.get(FREE_SEED)).toBe("free")
    expect(m.get("user_cancelled")).toBeUndefined() // cancelled sub is not active → not in map
  })

  it("billingCounts reflect the snapshot composition", async () => {
    const resolution = await resolveSegments(await makeDb())
    expect(resolution.billingCounts).toEqual({ subscribers: 1, friend: 1, free: 1 })
  })
})

describe("segmentStage — $switch branch order is load-bearing", () => {
  it("emits dev → team → subscribers → friend, default free", async () => {
    const resolution = await resolveSegments(makeFakeDb([]).db)
    const stage = segmentStage(resolution) as { $addFields: { seg: { $switch: { branches: { then: string }[]; default: string } } } }
    const branches = stage.$addFields.seg.$switch.branches
    expect(branches.map((b) => b.then)).toEqual(["dev", "team", "subscribers", "friend"])
    expect(stage.$addFields.seg.$switch.default).toBe("free")
  })
})

// ---------------------------------------------------------------------------
// Aggregation tests — the cuadre (reconciliation) invariants
// ---------------------------------------------------------------------------

const RANGE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-28T00:00:00Z") }

function octoberSessions(): SessionDoc[] {
  return [
    // dev — 3 sessions, one capped by flag, one by legacy range, one normal
    session({ userId: DEV, costUsd: 3.5, durationMs: 1_800_000, durationCapped: true, startedAt: new Date("2026-10-02T09:00:00Z") }),
    session({ userId: DEV, costUsd: 2.25, durationMs: 1_795_000, startedAt: new Date("2026-10-03T09:00:00Z") }), // legacy range, no flag
    session({ userId: DEV, costUsd: 1.25, durationMs: 300_000, startedAt: new Date("2026-10-04T09:00:00Z") }),
    // team — Álvaro (comped pro), Magüi (no sub)
    session({ userId: ALVARO, costUsd: 10, durationMs: 600_000, startedAt: new Date("2026-10-05T09:00:00Z"), agentId: "agent_2" }),
    session({ userId: MAGUI, costUsd: 0.5, durationMs: 120_000, startedAt: new Date("2026-10-06T09:00:00Z"), agentId: "agent_2" }),
    // subscribers
    session({ userId: SUBSCRIBER, costUsd: 7.77, durationMs: 1_805_000, startedAt: new Date("2026-10-07T09:00:00Z"), agentId: "agent_3" }), // capped, upper edge
    session({ userId: SUBSCRIBER, costUsd: 2.23, durationMs: 240_000, startedAt: new Date("2026-10-08T09:00:00Z"), agentId: "agent_3" }),
    // friend
    session({ userId: FRIEND, costUsd: 4.5, durationMs: 1_800_000, startedAt: new Date("2026-10-09T09:00:00Z"), agentId: "agent_4" }), // capped
    // free
    session({ userId: FREE_SEED, costUsd: 0.02, durationMs: 60_000, startedAt: new Date("2026-10-10T09:00:00Z"), agentId: "agent_5" }),
    session({ userId: FREE_NOSUB, costUsd: 0.01, durationMs: 30_000, startedAt: new Date("2026-10-11T09:00:00Z"), agentId: "agent_5" }),
    // outside the window — must be excluded
    session({ userId: DEV, costUsd: 99, durationMs: 60_000, startedAt: new Date("2026-09-30T09:00:00Z") }),
    session({ userId: DEV, costUsd: 99, durationMs: 60_000, startedAt: new Date("2026-10-28T00:00:00Z") }), // to is exclusive
    // demo seed — must be excluded
    session({ userId: DEV, costUsd: 99, durationMs: 60_000, demoSeed: true }),
  ]
}

describe("costsOverview — reconciliation to the cent (cuadre)", () => {
  it("dev+team+subscribers+friend+free = total for cost, sessions and durations", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsOverview(db, RANGE)) as {
      segments: { segment: string; sessions: number; costUsd: number; durMsRaw: number; durMsAdjusted: number; cappedSessions: number }[]
      total: { sessions: number; costUsd: number; durMsRaw: number; durMsAdjusted: number; cappedSessions: number }
    }

    const bySeg = new Map(result.segments.map((s) => [s.segment, s]))
    expect([...bySeg.keys()].sort()).toEqual([...SEGMENTS].sort())

    // Segment expectations
    const dev = bySeg.get("dev")!
    expect(dev.sessions).toBe(3)
    expect(dev.costUsd).toBe(7) // 3.5+2.25+1.25 — cost unaffected by the cap
    expect(dev.durMsRaw).toBe(1_800_000 + 1_795_000 + 300_000)
    expect(dev.durMsAdjusted).toBe(300_000) // both capped sessions excluded
    expect(dev.cappedSessions).toBe(2) // one by flag, one by legacy range

    const team = bySeg.get("team")!
    expect(team.sessions).toBe(2)
    expect(team.costUsd).toBe(10.5)
    expect(team.nUsers).toBe(2)

    const subscribers = bySeg.get("subscribers")!
    expect(subscribers.sessions).toBe(2)
    expect(subscribers.costUsd).toBe(10)
    expect(subscribers.cappedSessions).toBe(1) // 1_805_000 upper edge
    expect(subscribers.durMsAdjusted).toBe(240_000)

    const friend = bySeg.get("friend")!
    expect(friend.sessions).toBe(1)
    expect(friend.cappedSessions).toBe(1)
    expect(friend.durMsAdjusted).toBe(0)
    expect(friend.hoursAdjusted).toBe(0)
    expect(friend.usdHourAdjusted).toBe(null) // no misleading Infinity

    const free = bySeg.get("free")!
    expect(free.sessions).toBe(2)
    expect(free.costUsd).toBe(0.03)

    // THE cuadre: segments sum exactly to the total
    const sumCost = result.segments.reduce((a, s) => a + s.costUsd, 0)
    expect(Math.round(sumCost * 100)).toBe(Math.round(result.total.costUsd * 100))
    expect(result.segments.reduce((a, s) => a + s.sessions, 0)).toBe(result.total.sessions)
    expect(result.segments.reduce((a, s) => a + s.durMsRaw, 0)).toBe(result.total.durMsRaw)
    expect(result.segments.reduce((a, s) => a + s.durMsAdjusted, 0)).toBe(result.total.durMsAdjusted)
    expect(result.segments.reduce((a, s) => a + s.cappedSessions, 0)).toBe(result.total.cappedSessions)

    // Window + demoSeed exclusions: 10 in-window real sessions (dev 3 + team 2
    // + subscribers 2 + friend 1 + free 2), $32.03 total
    expect(result.total.sessions).toBe(10)
    expect(result.total.costUsd).toBe(32.03)
  })

  it("hours = durMs/3.6e6 and usd/hour raw+adjusted are coherent", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsOverview(db, RANGE)) as {
      segments: {
        segment: string
        hoursRaw: number
        hoursAdjusted: number
        usdHourRaw: number | null
        usdHourAdjusted: number | null
        durMsRaw: number
        durMsAdjusted: number
        costUsd: number
      }[]
    }
    const dev = result.segments.find((s) => s.segment === "dev")!
    expect(dev.hoursRaw).toBeCloseTo(dev.durMsRaw / 3_600_000, 2)
    expect(dev.hoursAdjusted).toBeCloseTo(dev.durMsAdjusted / 3_600_000, 2)
    expect(dev.usdHourRaw).toBeCloseTo(dev.costUsd / (dev.durMsRaw / 3_600_000), 1)
    expect(dev.usdHourAdjusted).toBeCloseTo(dev.costUsd / (dev.durMsAdjusted / 3_600_000), 1)
    // adjusted hours < raw hours when capped sessions exist, cost identical
    expect(dev.hoursAdjusted).toBeLessThan(dev.hoursRaw)
  })

  it("tokens, cacheRatio, nUsers, nAgents and ttftP50 are computed per segment", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsOverview(db, RANGE)) as {
      segments: {
        segment: string
        inputTokens: number
        cachedReadTokens: number
        outputTokens: number
        cacheRatio: number | null
        nUsers: number
        nAgents: number
        ttftP50: number | null
      }[]
    }
    const dev = result.segments.find((s) => s.segment === "dev")!
    expect(dev.inputTokens).toBe(3000)
    expect(dev.outputTokens).toBe(1500)
    expect(dev.cachedReadTokens).toBe(0)
    expect(dev.cacheRatio).toBe(0)
    expect(dev.ttftP50).toBe(800)
    expect(dev.nAgents).toBe(1)

    const team = result.segments.find((s) => s.segment === "team")!
    expect(team.nUsers).toBe(2)
    expect(team.nAgents).toBe(1) // both used agent_2
  })
})

describe("costsWeekly — ISO week × segment buckets", () => {
  it("buckets sessions into ISO weeks with the same totals arithmetic", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsWeekly(db, RANGE)) as {
      weeks: { week: string; segment: string; sessions: number; costUsd: number; durMsRaw: number; durMsAdjusted: number; cappedSessions: number }[]
    }
    expect(result.weeks.length).toBeGreaterThan(0)

    // Every row is a valid ISO week key
    for (const w of result.weeks) expect(w.week).toMatch(/^\d{4}-W\d{2}$/)

    // The cuadre across weeks = the overview total
    const sumCost = result.weeks.reduce((a, w) => a + w.costUsd, 0)
    const sumSessions = result.weeks.reduce((a, w) => a + w.sessions, 0)
    const overview = (await costsOverview(db, RANGE)) as { total: { costUsd: number; sessions: number } }
    expect(Math.round(sumCost * 100)).toBe(Math.round(overview.total.costUsd * 100))
    expect(sumSessions).toBe(overview.total.sessions)

    // 2026-10-02..04 (dev) is ISO week 40; 10-05..06 (team) week 41
    const devW40 = result.weeks.find((w) => w.week === "2026-W40" && w.segment === "dev")
    expect(devW40?.sessions).toBe(3)
    const teamW41 = result.weeks.find((w) => w.week === "2026-W41" && w.segment === "team")
    expect(teamW41?.sessions).toBe(2)
  })
})

describe("costsByUser — per-account rows with email + cost percentiles", () => {
  it("resolves emails from users.profile.email and computes p50/p90/max", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsByUser(db, RANGE, "all")) as {
      users: {
        userId: string
        segment: string
        email: string | null
        sessions: number
        costUsd: number
        costP50: number | null
        costP90: number | null
        costMax: number | null
        durMsRaw: number
        durMsAdjusted: number
        cappedSessions: number
      }[]
    }

    const alvaro = result.users.find((u) => u.userId === ALVARO)!
    expect(alvaro.segment).toBe("team")
    expect(alvaro.email).toBe("alvaro@example.agentapps.tech")

    // dev: costs [1.25, 2.25, 3.5] → p50=2.25, p90=3.5, max=3.5
    const dev = result.users.find((u) => u.userId === DEV)!
    expect(dev.segment).toBe("dev")
    expect(dev.email).toBe("pablo@example.agentapps.tech")
    expect(dev.sessions).toBe(3)
    expect(dev.costUsd).toBe(7)
    expect(dev.costP50).toBe(2.25)
    expect(dev.costP90).toBe(3.5)
    expect(dev.costMax).toBe(3.5)
    expect(dev.cappedSessions).toBe(2)
    expect(dev.durMsAdjusted).toBe(300_000)

    // A user with no users doc resolves email: null (NOT a crash)
    const nosub = result.users.find((u) => u.userId === FREE_NOSUB)!
    expect(nosub.email).toBe(null)

    // Sorted by cost desc — the most expensive account first
    expect(result.users[0].userId).toBe(ALVARO)
  })

  it("seg=team filters to team members only", async () => {
    const { db } = makeFakeDb(octoberSessions())
    const result = (await costsByUser(db, RANGE, "team")) as { users: { userId: string; segment: string }[] }
    expect(result.users.map((u) => u.userId).sort()).toEqual([ALVARO, MAGUI].sort())
    for (const u of result.users) expect(u.segment).toBe("team")
  })
})

describe("costsByModel — provider × modelId rows", () => {
  it("groups by provider×modelId with tokens, cacheRatio and cap arithmetic", async () => {
    const docs = [
      session({ userId: SUBSCRIBER, provider: "teros", modelId: "teros-kimi-k2.6", costUsd: 2, inputTokens: 1000, cachedReadTokens: 600, outputTokens: 400, durationMs: 1_800_000, durationCapped: true }),
      session({ userId: SUBSCRIBER, provider: "teros", modelId: "teros-kimi-k2.6", costUsd: 3, inputTokens: 1000, cachedReadTokens: 200, outputTokens: 400, durationMs: 300_000 }),
      session({ userId: SUBSCRIBER, provider: "anthropic-oauth", modelId: "claude-sonnet-4.5", costUsd: 5, inputTokens: 500, cachedReadTokens: 0, outputTokens: 250, durationMs: 120_000 }),
    ]
    const { db } = makeFakeDb(docs)
    const result = (await costsByModel(db, RANGE, "all")) as {
      models: { provider: string; modelId: string; sessions: number; costUsd: number; cacheRatio: number | null; durMsRaw: number; durMsAdjusted: number; cappedSessions: number; ttftP50: number | null }[]
    }

    const kimi = result.models.find((m) => m.provider === "teros")!
    expect(kimi.modelId).toBe("teros-kimi-k2.6")
    expect(kimi.sessions).toBe(2)
    expect(kimi.costUsd).toBe(5)
    expect(kimi.cacheRatio).toBeCloseTo(800 / 2000, 3)
    expect(kimi.durMsRaw).toBe(2_100_000)
    expect(kimi.durMsAdjusted).toBe(300_000)
    expect(kimi.cappedSessions).toBe(1)
    expect(kimi.ttftP50).toBe(800)

    const claude = result.models.find((m) => m.provider === "anthropic-oauth")!
    expect(claude.sessions).toBe(1)
    expect(claude.costUsd).toBe(5)
  })
})

describe("costsTriggers — triggerKind × segment rows", () => {
  it("groups by triggerKind×segment with cap arithmetic", async () => {
    const docs = [
      session({ userId: DEV, triggerKind: "user_message", costUsd: 1, durationMs: 1_800_000, durationCapped: true }),
      session({ userId: DEV, triggerKind: "user_message", costUsd: 2, durationMs: 300_000 }),
      session({ userId: DEV, triggerKind: "autorun", costUsd: 4, durationMs: 600_000 }),
      session({ userId: SUBSCRIBER, triggerKind: "scheduled", costUsd: 8, durationMs: 120_000 }),
    ]
    const { db } = makeFakeDb(docs)
    const result = (await costsTriggers(db, RANGE, "all")) as {
      triggers: { triggerKind: string; segment: string; sessions: number; costUsd: number; durMsRaw: number; durMsAdjusted: number; cappedSessions: number }[]
    }

    const umDev = result.triggers.find((t) => t.triggerKind === "user_message" && t.segment === "dev")!
    expect(umDev.sessions).toBe(2)
    expect(umDev.costUsd).toBe(3)
    expect(umDev.durMsRaw).toBe(2_100_000)
    expect(umDev.durMsAdjusted).toBe(300_000)
    expect(umDev.cappedSessions).toBe(1)

    const schedSub = result.triggers.find((t) => t.triggerKind === "scheduled" && t.segment === "subscribers")!
    expect(schedSub.costUsd).toBe(8)
  })
})

describe("accumulateRow / finalizeTotals — cap arithmetic invariants", () => {
  it("raw = adjusted + capped durations; cappedSessions counted once", () => {
    const t = emptyTotals()
    accumulateRow(t, { seg: "dev", userId: "u", agentId: "a", provider: "p", modelId: "m", triggerKind: "k", startedAt: new Date(0), durationMs: 1_800_000, durationCapped: true, costUsd: 1, inputTokens: 10, cachedReadTokens: 0, outputTokens: 5, ttftMs: 100 } as never)
    accumulateRow(t, { seg: "dev", userId: "u", agentId: "a", provider: "p", modelId: "m", triggerKind: "k", startedAt: new Date(0), durationMs: 300_000, costUsd: 1, inputTokens: 10, cachedReadTokens: 0, outputTokens: 5, ttftMs: 300 } as never)
    const out = finalizeTotals("dev", t)
    expect(out.durMsRaw).toBe(2_100_000)
    expect(out.durMsAdjusted).toBe(300_000)
    expect(out.cappedSessions).toBe(1)
    expect(out.sessions).toBe(2)
    expect(out.ttftP50).toBe(100) // [100, 300] → nearest-rank p50 = idx 0? ceil(0.5*2)-1 = 0 → 100
    expect(out.usdHourAdjusted).toBeCloseTo(2 / (300_000 / 3_600_000), 1) // $24/h
  })
})
