/**
 * Characterization tests for AgentUsageRollupJob.processHour (R2 prerequisite).
 *
 * Documents the CURRENT behavior of processHour before the Split Phase
 * refactor. Uses an in-memory Mongo-like fake (cursor + updateOne) so the
 * test is hermetic and fast. The test asserts the SHAPE of the upserts that
 * the job produces, not the implementation details.
 *
 * Scenarios covered:
 *  - Empty hour → 0 docs written.
 *  - Single session entirely inside the hour → 1 hourly + 1 user_hourly.
 *  - Cross-midnight session → split proportional across both buckets.
 *  - Still-running session → excluded (cutoff policy).
 *  - Two sessions of same (user, agent, provider) → aggregated in one hourly.
 *
 * After the refactor these tests must still pass unchanged.
 */

import { describe, expect, it } from 'bun:test'
import {
  AgentUsageRollupJob,
  truncateToHourUTC,
} from '../../src/services/agent-usage-rollup-job'
import type {
  AgentUsageRollupHourly,
  AgentUsageRollupUserHourly,
  AgentUsageSession,
} from '../../src/types/database'

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

interface Upsert {
  collection: 'hourly' | 'user_hourly'
  filter: any
  doc: any
}

interface Marker {
  hourBucket: Date
  jobRunId: string
  agentDocsWritten: number
  userDocsWritten: number
}

function makeSession(overrides: Partial<AgentUsageSession>): AgentUsageSession {
  return {
    sessionUsageId: 'usess_x',
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    actualModel: undefined,
    startedAt: new Date('2026-05-20T10:00:00Z'),
    endedAt: new Date('2026-05-20T10:00:30Z'),
    durationMs: 30_000,
    durationSource: 'monotonic',
    status: 'completed',
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 150,
    costUsd: 0.01,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 1,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeDb(sessions: AgentUsageSession[], hourlyExisting: AgentUsageRollupHourly[] = []) {
  const upserts: Upsert[] = []
  // Completion markers written by the job (agent_usage_rollup_runs). Mirrors the
  // real collection so processHour/runOnce exercise the actual gate rather than a
  // no-op — a demoSeed doc in `hourlyExisting` must NOT show up here.
  const markers: Marker[] = []
  return {
    upserts,
    markers,
    db: {
      collection(name: string) {
        if (name === 'agent_usage_sessions') {
          return {
            find(filter: any) {
              const matches = sessions.filter((s) => sessionMatchesOverlap(s, filter))
              return makeCursor(matches)
            },
          }
        }
        if (name === 'agent_usage_rollups_hourly') {
          return {
            async findOne(filter: any) {
              // latestRollupBucket() calls findOne({}, {sort}) with no hourBucket.
              if (!filter?.hourBucket) {
                if (hourlyExisting.length === 0) return null
                return [...hourlyExisting].sort(
                  (a, b) => b.hourBucket.getTime() - a.hourBucket.getTime(),
                )[0]
              }
              return (
                hourlyExisting.find(
                  (r) => r.hourBucket.getTime() === filter.hourBucket.getTime(),
                ) ?? null
              )
            },
            async updateOne(filter: any, update: any, _opts: any) {
              upserts.push({ collection: 'hourly', filter, doc: update.$set })
              return { matchedCount: 0, upsertedCount: 1 }
            },
          }
        }
        if (name === 'agent_usage_rollups_user_hourly') {
          return {
            async updateOne(filter: any, update: any, _opts: any) {
              upserts.push({ collection: 'user_hourly', filter, doc: update.$set })
              return { matchedCount: 0, upsertedCount: 1 }
            },
          }
        }
        if (name === 'agent_usage_rollup_runs') {
          return {
            async findOne(filter: any) {
              return (
                markers.find((m) => m.hourBucket.getTime() === filter.hourBucket.getTime()) ?? null
              )
            },
            async updateOne(filter: any, update: any, _opts: any) {
              const existing = markers.find(
                (m) => m.hourBucket.getTime() === filter.hourBucket.getTime(),
              )
              if (existing) Object.assign(existing, update.$set)
              else markers.push(update.$set)
              return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 }
            },
          }
        }
        return null as any
      },
    },
  }
}

function makeCursor<T>(items: T[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < items.length) return Promise.resolve({ value: items[i++], done: false })
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
    async close() {},
  }
}

function sessionMatchesOverlap(s: AgentUsageSession, filter: any): boolean {
  const startedAtLt = filter.startedAt?.$lt
  if (startedAtLt && !(s.startedAt < startedAtLt)) return false
  // Faithful to Mongo `{ demoSeed: { $ne: true } }`: exclude explicit demo docs,
  // keep real docs that simply omit the field.
  if (filter.demoSeed?.$ne === true && s.demoSeed === true) return false
  const orConditions = filter.$or as Array<{ endedAt: any }> | undefined
  if (!orConditions) return true
  return orConditions.some((c) => {
    if (c.endedAt === null) return s.endedAt === null
    const gt = c.endedAt?.$gt
    if (gt) return s.endedAt !== null && s.endedAt > gt
    return false
  })
}

const HOUR = new Date('2026-05-20T10:00:00Z')

describe('AgentUsageRollupJob.processHour (characterization)', () => {
  it('writes 0 docs when there are no sessions', async () => {
    const { db, upserts } = makeDb([])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    const docs = await job.processHour(HOUR)
    expect(docs).toBe(0)
    expect(upserts).toHaveLength(0)
  })

  it('writes 1 hourly + 1 user_hourly for a single in-bucket session', async () => {
    const { db, upserts } = makeDb([makeSession({})])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    const docs = await job.processHour(HOUR)
    expect(docs).toBe(2)
    expect(upserts).toHaveLength(2)
    const hourly = upserts.find((u) => u.collection === 'hourly')!
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(hourly.doc.inputTokens).toBe(100)
    expect(hourly.doc.outputTokens).toBe(50)
    expect(hourly.doc.totalTokens).toBe(150)
    expect(hourly.doc.sessionCount).toBe(1)
    expect(hourly.doc.completedCount).toBe(1)
    expect(hourly.doc.agentActiveMs).toBe(30_000)
    expect(userHourly.doc.userActiveMs).toBe(30_000)
    expect(userHourly.doc.sessionCount).toBe(1)
    expect(userHourly.doc.totalTokens).toBe(150)
  })

  it('skips still-running sessions (cutoff policy)', async () => {
    const running = makeSession({
      endedAt: null,
      durationMs: null,
      status: 'running',
    })
    const { db, upserts } = makeDb([running])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    const docs = await job.processHour(HOUR)
    expect(docs).toBe(0)
    expect(upserts).toHaveLength(0)
  })

  it('never bills a reconciler zombie (timed_out + reconciled_timeout, 0 tokens)', async () => {
    // The phantom-session incident (TER-650): a hung turn the reconciler closed
    // as timed_out with 19.5 min of wall-clock. It must produce NO rollup docs.
    const zombie = makeSession({
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      durationMs: 1_170_000, // 19.5 min
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:19:30Z'),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    })
    const { db, upserts } = makeDb([zombie])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    const docs = await job.processHour(HOUR)
    expect(docs).toBe(0)
    expect(upserts).toHaveLength(0)
  })

  it('excludes phantom wall-clock from userActiveMs when mixed with a real session', async () => {
    // Real session (30s, completed) + phantom (19.5 min, reconciled_timeout, 0
    // tokens), disjoint in time within the same hour. WITHOUT the guard the
    // union would be 30_000 + 1_170_000 = 1_200_000; WITH it, only the real 30s.
    const real = makeSession({
      sessionUsageId: 'usess_real',
      startedAt: new Date('2026-05-20T10:30:00Z'),
      endedAt: new Date('2026-05-20T10:30:30Z'),
      durationMs: 30_000,
      totalTokens: 150,
    })
    const phantom = makeSession({
      sessionUsageId: 'usess_phantom',
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:19:30Z'),
      durationMs: 1_170_000,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    })
    const { db, upserts } = makeDb([real, phantom])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.userActiveMs).toBe(30_000)
    expect(userHourly.doc.sessionCount).toBe(1)
    expect(userHourly.doc.totalTokens).toBe(150)
  })

  it('splits a cross-midnight session proportionally between two hours', async () => {
    // Session [09:30 - 10:30) overlaps two hours equally (30min each).
    // Calling processHour for the 10:00 bucket should account for half of
    // the tokens and 30min of activeMs.
    const crossMidnight = makeSession({
      startedAt: new Date('2026-05-20T09:30:00Z'),
      endedAt: new Date('2026-05-20T10:30:00Z'),
      durationMs: 60 * 60 * 1000,
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      costUsd: 0.02,
    })
    const { db, upserts } = makeDb([crossMidnight])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const hourly = upserts.find((u) => u.collection === 'hourly')!
    // 50% fraction for this hour
    expect(hourly.doc.inputTokens).toBe(100)
    expect(hourly.doc.outputTokens).toBe(50)
    expect(hourly.doc.totalTokens).toBe(150)
    expect(hourly.doc.agentActiveMs).toBe(30 * 60 * 1000)
    // costUsd is half too
    expect(hourly.doc.costUsd).toBeCloseTo(0.01, 5)
  })

  it('aggregates two sessions of the same (user, agent, provider) into one hourly doc', async () => {
    const s1 = makeSession({
      sessionUsageId: 'usess_a',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      durationMs: 10_000,
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:00:10Z'),
    })
    const s2 = makeSession({
      sessionUsageId: 'usess_b',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      durationMs: 20_000,
      startedAt: new Date('2026-05-20T10:00:30Z'),
      endedAt: new Date('2026-05-20T10:00:50Z'),
    })
    const { db, upserts } = makeDb([s1, s2])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const hourly = upserts.find((u) => u.collection === 'hourly')!
    expect(hourly.doc.sessionCount).toBe(2)
    expect(hourly.doc.inputTokens).toBe(300)
    expect(hourly.doc.outputTokens).toBe(150)
    expect(hourly.doc.totalTokens).toBe(450)
    expect(hourly.doc.agentActiveMs).toBe(30_000)
    // Per-user agg
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.sessionCount).toBe(2)
    expect(userHourly.doc.totalTokens).toBe(450)
  })

  it('separates two sessions of different agents into two hourly docs but one user_hourly', async () => {
    const s1 = makeSession({ sessionUsageId: 'usess_a', agentId: 'agent_a' })
    const s2 = makeSession({ sessionUsageId: 'usess_b', agentId: 'agent_b' })
    const { db, upserts } = makeDb([s1, s2])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const hourly = upserts.filter((u) => u.collection === 'hourly')
    const userHourly = upserts.filter((u) => u.collection === 'user_hourly')
    expect(hourly).toHaveLength(2)
    expect(userHourly).toHaveLength(1)
    expect(userHourly[0].doc.sessionCount).toBe(2)
  })

  // ==========================================================================
  // Decision #29 — userWorkMs (sum of overlaps) vs userActiveMs (union)
  // ==========================================================================

  it('WS1: two OVERLAPPING sessions → userActiveMs = union, userWorkMs = sum', async () => {
    // Two parallel agents, same user, both working 10:00:00–10:10:00 (10 min).
    // Union = 10 min (wall-clock the user was "active"); work = 20 min (two
    // agents × 10 min — what the quota must burn, decision #29).
    const s1 = makeSession({
      sessionUsageId: 'usess_p1',
      agentId: 'agent_a',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:10:00Z'),
      durationMs: 10 * 60_000,
    })
    const s2 = makeSession({
      sessionUsageId: 'usess_p2',
      agentId: 'agent_b',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:10:00Z'),
      durationMs: 10 * 60_000,
    })
    const { db, upserts } = makeDb([s1, s2])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.userActiveMs).toBe(10 * 60_000) // union — unchanged (decision #26)
    expect(userHourly.doc.userWorkMs).toBe(20 * 60_000) // sum — the billed metric (decision #29)
    expect(userHourly.doc.schemaVersion).toBe(2)
  })

  it('WS1: partial overlap → union < sum, both correct', async () => {
    // A: 10:00–10:10, B: 10:05–10:15. Union = 15 min; sum = 20 min.
    const s1 = makeSession({
      sessionUsageId: 'usess_q1',
      agentId: 'agent_a',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:10:00Z'),
      durationMs: 10 * 60_000,
    })
    const s2 = makeSession({
      sessionUsageId: 'usess_q2',
      agentId: 'agent_b',
      startedAt: new Date('2026-05-20T10:05:00Z'),
      endedAt: new Date('2026-05-20T10:15:00Z'),
      durationMs: 10 * 60_000,
    })
    const { db, upserts } = makeDb([s1, s2])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.userActiveMs).toBe(15 * 60_000)
    expect(userHourly.doc.userWorkMs).toBe(20 * 60_000)
  })

  it('WS1: session crossing the hour boundary → correct fraction in BOTH fields', async () => {
    // Session [09:30 - 10:30) overlaps the 10:00 hour by exactly 30 min.
    // Both metrics must carry the same clamped 30 min for this bucket.
    const cross = makeSession({
      sessionUsageId: 'usess_cross',
      startedAt: new Date('2026-05-20T09:30:00Z'),
      endedAt: new Date('2026-05-20T10:30:00Z'),
      durationMs: 60 * 60 * 1000,
    })
    const { db, upserts } = makeDb([cross])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.userActiveMs).toBe(30 * 60 * 1000)
    expect(userHourly.doc.userWorkMs).toBe(30 * 60 * 1000)
    // Tokens split proportionally (50%) — unchanged behavior.
    expect(userHourly.doc.totalTokens).toBe(75)
  })

  it('WS1: phantom sessions excluded from userWorkMs exactly like userActiveMs (TER-650)', async () => {
    // Real 30s + phantom 19.5min reconciled_timeout overlapping the real one.
    // The phantom must contribute to NEITHER metric.
    const real = makeSession({
      sessionUsageId: 'usess_real',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:00:30Z'),
      durationMs: 30_000,
      totalTokens: 150,
    })
    const phantom = makeSession({
      sessionUsageId: 'usess_phantom',
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:19:30Z'),
      durationMs: 1_170_000,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    })
    const { db, upserts } = makeDb([real, phantom])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    const userHourly = upserts.find((u) => u.collection === 'user_hourly')!
    expect(userHourly.doc.userActiveMs).toBe(30_000)
    expect(userHourly.doc.userWorkMs).toBe(30_000)
    expect(userHourly.doc.sessionCount).toBe(1)
  })

  it('WS1: computeUserBilledMsForHour exposes both metrics (work = sum, active = union)', async () => {
    const s1 = makeSession({
      sessionUsageId: 'usess_w1',
      agentId: 'agent_a',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:10:00Z'),
      durationMs: 10 * 60_000,
    })
    const s2 = makeSession({
      sessionUsageId: 'usess_w2',
      agentId: 'agent_b',
      startedAt: new Date('2026-05-20T10:00:00Z'),
      endedAt: new Date('2026-05-20T10:10:00Z'),
      durationMs: 10 * 60_000,
    })
    const { db } = makeDb([s1, s2])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    const work = await job.computeUserBilledMsForHour(HOUR)
    const active = await job.computeUserActiveMsForHour(HOUR)

    expect(work.get('user_1')).toBe(20 * 60_000)
    expect(active.get('user_1')).toBe(10 * 60_000)
  })
})

// ============================================================================
// TER-665 / A1.2 — demo-seed exclusion + per-hour completion marker
// ============================================================================

describe('AgentUsageRollupJob demo-seed exclusion + completion marker', () => {
  it('does NOT fold demoSeed sessions into the real rollup', async () => {
    // Same (user, agent, provider) so a leaked demo session would inflate the
    // one real hourly doc. If the overlap filter stops excluding demoSeed, the
    // rolled totals double (mutation → red).
    const real = makeSession({ sessionUsageId: 'usess_real', inputTokens: 100, outputTokens: 50, totalTokens: 150 })
    const demo = makeSession({
      sessionUsageId: 'usess_demo',
      demoSeed: true,
      inputTokens: 9_999,
      outputTokens: 9_999,
      totalTokens: 19_998,
    })
    const { db, upserts } = makeDb([real, demo])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    const docs = await job.processHour(HOUR)

    expect(docs).toBe(2) // one hourly + one user_hourly, from the REAL session only
    const hourly = upserts.filter((u) => u.collection === 'hourly')
    expect(hourly).toHaveLength(1)
    expect(hourly[0].doc.sessionCount).toBe(1)
    expect(hourly[0].doc.inputTokens).toBe(100)
    expect(hourly[0].doc.totalTokens).toBe(150)
  })

  it('writes a completion marker after a successful hour (and none for an empty hour)', async () => {
    const { db, markers } = makeDb([makeSession({})])
    const job = new AgentUsageRollupJob(db as any, stubLogger)
    await job.processHour(HOUR)
    expect(markers).toHaveLength(1)
    expect(markers[0].hourBucket.getTime()).toBe(HOUR.getTime())
    expect(markers[0].agentDocsWritten).toBe(1)
    expect(markers[0].userDocsWritten).toBe(1)

    // An empty hour is final too and gets marked (BIL-3): the tracker bills up
    // to the first unmarked hour, so leaving gaps would stall billing.
    const empty = makeDb([])
    const emptyJob = new AgentUsageRollupJob(empty.db as any, stubLogger)
    await emptyJob.processHour(HOUR)
    expect(empty.markers).toHaveLength(1)
    expect(empty.markers[0].agentDocsWritten).toBe(0)
  })

  it('BIL-2: leaves an hour unmarked while a recent session overlapping it is still open', async () => {
    const recentHour = new Date(truncateToHourUTC(new Date()).getTime() - 3_600_000)
    const closed = makeSession({
      sessionUsageId: 'usess_closed',
      startedAt: new Date(recentHour.getTime() + 60_000),
      endedAt: new Date(recentHour.getTime() + 90_000),
    })
    const open = makeSession({
      sessionUsageId: 'usess_open',
      startedAt: new Date(recentHour.getTime() + 50 * 60_000),
      endedAt: null as any,
      status: 'running' as any,
    })
    const { db, upserts, markers } = makeDb([closed, open])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    await job.processHour(recentHour)

    expect(upserts.length).toBeGreaterThan(0) // the closed session is still rolled
    expect(markers).toHaveLength(0) // but the hour is not final
  })

  it('BIL-2: a long-open zombie session does not hold the hour back', async () => {
    const oldHour = new Date(truncateToHourUTC(new Date()).getTime() - 5 * 3_600_000)
    const zombie = makeSession({
      sessionUsageId: 'usess_zombie',
      startedAt: new Date(oldHour.getTime() + 60_000),
      endedAt: null as any,
      status: 'running' as any,
    })
    const { db, markers } = makeDb([zombie])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    await job.processHour(oldHour)

    expect(markers).toHaveLength(1)
  })

  it('BIL-2: a failed upsert leaves the hour unmarked so it is retried', async () => {
    const env = makeDb([makeSession({})])
    const realCollection = env.db.collection.bind(env.db)
    env.db.collection = (name: string) => {
      const col = realCollection(name)
      if (name !== 'agent_usage_rollups_user_hourly') return col
      return {
        ...col,
        async updateOne() {
          throw new Error('write failed')
        },
      }
    }
    const job = new AgentUsageRollupJob(env.db as any, stubLogger)

    await job.processHour(HOUR)

    expect(env.markers).toHaveLength(0)
  })

  it('rolls the real sessions of an hour that already holds a demo rollup (A1.2 acceptance)', async () => {
    // The exact bug: demo seed wrote a rollup doc for this hour. The OLD gate
    // (hourlyCol.findOne({hourBucket})) would find it and skip the hour forever,
    // dropping the real sessions. The marker gate must roll them anyway.
    const recentHour = new Date(truncateToHourUTC(new Date()).getTime() - 2 * 3_600_000)
    const started = new Date(recentHour.getTime() + 5 * 60_000)
    const ended = new Date(started.getTime() + 30_000)
    const real = makeSession({ sessionUsageId: 'usess_real', startedAt: started, endedAt: ended })
    const demo = makeSession({
      sessionUsageId: 'usess_demo',
      demoSeed: true,
      startedAt: started,
      endedAt: ended,
      inputTokens: 9_999,
    })
    const demoRollup = {
      rollupId: 'usro_demo_x',
      hourBucket: recentHour,
      demoSeed: true,
    } as unknown as AgentUsageRollupHourly
    const { db, upserts, markers } = makeDb([real, demo], [demoRollup])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    await job.runOnce()

    // Real session rolled despite the pre-existing demo rollup for the hour; the
    // demo session was excluded from the fold.
    const hourly = upserts.filter((u) => u.collection === 'hourly')
    expect(hourly).toHaveLength(1)
    expect(hourly[0].doc.sessionCount).toBe(1) // real only, demo excluded
    expect(hourly[0].doc.hourBucket.getTime()).toBe(recentHour.getTime())
    expect(markers.some((m) => m.hourBucket.getTime() === recentHour.getTime())).toBe(true)
  })

  it('skips an already-marked hour on a second run (no repeated real work)', async () => {
    const recentHour = new Date(truncateToHourUTC(new Date()).getTime() - 2 * 3_600_000)
    const started = new Date(recentHour.getTime() + 5 * 60_000)
    const real = makeSession({
      sessionUsageId: 'usess_real',
      startedAt: started,
      endedAt: new Date(started.getTime() + 30_000),
    })
    const { db, upserts, markers } = makeDb([real])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    await job.runOnce()
    const afterFirst = upserts.length
    const markersAfterFirst = markers.length
    expect(afterFirst).toBeGreaterThan(0)
    expect(markers.some((m) => m.hourBucket.getTime() === recentHour.getTime())).toBe(true)

    // Second run: every scanned hour (data or empty) is marked → nothing is
    // reprocessed, no new upserts, no new markers.
    await job.runOnce()
    expect(upserts.length).toBe(afterFirst)
    expect(markers.length).toBe(markersAfterFirst)
  })

  it('reprocesses an hour that has a rollup doc but NO marker (partial-write recovery)', async () => {
    // A crash between the agent-rollup and the marker write leaves a doc without
    // a marker. Gating on doc-presence (old behavior) would skip it forever;
    // gating on the marker reprocesses it.
    const recentHour = new Date(truncateToHourUTC(new Date()).getTime() - 2 * 3_600_000)
    const started = new Date(recentHour.getTime() + 5 * 60_000)
    const real = makeSession({
      sessionUsageId: 'usess_real',
      startedAt: started,
      endedAt: new Date(started.getTime() + 30_000),
    })
    const priorDoc = {
      rollupId: 'usro_partial',
      hourBucket: recentHour,
    } as unknown as AgentUsageRollupHourly
    const { db, upserts } = makeDb([real], [priorDoc])
    const job = new AgentUsageRollupJob(db as any, stubLogger)

    await job.runOnce()
    expect(upserts.filter((u) => u.collection === 'hourly')).toHaveLength(1)
  })
})
