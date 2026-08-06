/**
 * Session lifecycle bound to EXECUTION, not the request (TER-650/G1 + G4).
 *
 * Against MongoDB real (:27019). Drives the real applier + repositories +
 * reconciler + rollup job through the queued→running→delta→ended lifecycle to
 * pin the money-critical invariants of the hot billing path:
 *
 *   - A session opens `queued` (no execution anchor) and only bills once
 *     `session.running` flips it to `running` with an execution-anchored
 *     startedAt. The queue wait is never billed.
 *   - `session.delta` tokens land on the session regardless of status (TER-691):
 *     on the real path the delta is emitted AFTER `session.ended`, so the old
 *     `{status:"running"}` guard dropped it and zeroed the session. Phantom
 *     billing is guarded downstream by isNonBillableSession(reconciled_timeout),
 *     not by dropping the delta.
 *   - The reconciler's stale threshold is derived from the turn deadline, so a
 *     legitimate 15–30 min turn is NOT closed to $0; a turn hung past the
 *     deadline (execution-orphan) and a turn whose worker died (queue-orphan)
 *     ARE closed, non-billable.
 *   - N coalesced sessions in the same hour union to ~1 billed interval (G4).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import { AgentUsageEventApplicationsRepository } from '../../src/services/agent-usage-event-applications-repository'
import { AgentUsageEventApplier } from '../../src/services/agent-usage-event-applier'
import { AgentUsageReconciler } from '../../src/services/agent-usage-reconciler'
import { AgentUsageRollupJob } from '../../src/services/agent-usage-rollup-job'
import { AgentUsageSessionRepository } from '../../src/services/agent-usage-session-repository'
import { ToolExecutionRepository } from '../../src/services/tool-execution-repository'
import type { AgentUsageEvent, AgentUsageSession } from '../../src/types/database'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27019'
const DB_NAME = `teros_lifecycle_g1_test_${Date.now()}`

const stubLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => stubLogger,
} as any

// Reconciler threshold as production derives it: ceil(turnDeadline/60_000)+buffer.
// With the default 30 min deadline + 5 min buffer → 35 min.
const RECONCILE_OPTS = {
  staleThresholdMin: 35,
  intervalMs: 5 * 60_000,
  leaderLockTtlMs: 60_000,
}
const MIN = 60_000

let client: MongoClient
let db: Db
let sessions: AgentUsageSessionRepository
let tools: ToolExecutionRepository
let applier: AgentUsageEventApplier

let seq = 0
function nextId(prefix: string): string {
  seq += 1
  return `${prefix}_${seq.toString().padStart(4, '0')}`
}

function startedEvent(sessionUsageId: string, at: Date, overrides: Record<string, unknown> = {}): AgentUsageEvent {
  return {
    eventId: nextId('usev'),
    sessionUsageId,
    type: 'session.started',
    payload: {
      parentSessionUsageId: null,
      triggerKind: 'user_message',
      userId: 'user_1',
      agentId: 'agent_1',
      workspaceId: 'work_1',
      channelId: 'ch_1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      startedAt: at,
      ...overrides,
    },
    appliedAt: at,
    schemaVersion: 1,
  } as AgentUsageEvent
}

function runningEvent(sessionUsageId: string, at: Date): AgentUsageEvent {
  return {
    eventId: nextId('usev'),
    sessionUsageId,
    type: 'session.running',
    payload: { startedAt: at },
    appliedAt: at,
    schemaVersion: 1,
  }
}

function deltaEvent(sessionUsageId: string, at: Date, tokens = { input: 100, output: 50 }): AgentUsageEvent {
  return {
    eventId: nextId('usev'),
    sessionUsageId,
    type: 'session.delta',
    payload: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.01,
      llmCallCount: 1,
      toolCallCount: 0,
    },
    appliedAt: at,
    schemaVersion: 1,
  }
}

function endedEvent(
  sessionUsageId: string,
  at: Date,
  status: 'completed' | 'aborted' | 'errored' = 'completed',
): AgentUsageEvent {
  return {
    eventId: nextId('usev'),
    sessionUsageId,
    type: 'session.ended',
    payload: {
      endedAt: at,
      durationMs: 1000,
      durationSource: 'monotonic',
      status,
      parentSessionUsageId: null,
    },
    appliedAt: at,
    schemaVersion: 1,
  }
}

/** Insert a fully-formed session doc directly (for reconciler/rollup scenarios). */
async function insertSession(overrides: Partial<AgentUsageSession>): Promise<void> {
  const now = new Date()
  await db.collection<AgentUsageSession>('agent_usage_sessions').insertOne({
    sessionUsageId: nextId('usess'),
    parentSessionUsageId: null,
    triggerKind: 'user_message',
    userId: 'user_1',
    agentId: 'agent_1',
    workspaceId: 'work_1',
    channelId: 'ch_1',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    durationSource: null,
    status: 'running',
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    descendantInputTokens: 0,
    descendantOutputTokens: 0,
    descendantCostUsd: 0,
    descendantSessionCount: 0,
    llmCallCount: 0,
    toolCallCount: 0,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AgentUsageSession)
}

function getSession(id: string) {
  return db.collection<AgentUsageSession>('agent_usage_sessions').findOne({ sessionUsageId: id })
}

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI)
  await client.connect()
  db = client.db(DB_NAME)
  await db
    .collection('agent_usage_sessions')
    .createIndex({ sessionUsageId: 1 }, { unique: true })
  sessions = new AgentUsageSessionRepository(db)
  tools = new ToolExecutionRepository(db)
  const applications = new AgentUsageEventApplicationsRepository(db)
  applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await db.collection('agent_usage_sessions').deleteMany({})
  await db.collection('agent_usage_event_applications').deleteMany({})
  await db.collection('agent_usage_rollups_hourly').deleteMany({})
  await db.collection('agent_usage_rollups_user_hourly').deleteMany({})
})

describe('lifecycle — queued → running → delta → ended (TER-650/G1)', () => {
  it('opens queued (startedAt null), flips to running with the execution anchor, then bills', async () => {
    const id = nextId('usess')
    const enqueuedAt = new Date('2026-05-20T10:00:00Z')
    const ranAt = new Date('2026-05-20T10:10:00Z') // 10 min queue wait
    const endedAt = new Date('2026-05-20T10:11:00Z')

    await applier.applyBatch([startedEvent(id, enqueuedAt)])
    let doc = await getSession(id)
    expect(doc!.status).toBe('queued')
    expect(doc!.startedAt).toBeNull()

    await applier.applyBatch([runningEvent(id, ranAt)])
    doc = await getSession(id)
    expect(doc!.status).toBe('running')
    // Execution anchor = when the turn actually started, NOT the enqueue time.
    expect(doc!.startedAt?.getTime()).toBe(ranAt.getTime())

    await applier.applyBatch([deltaEvent(id, ranAt), endedEvent(id, endedAt)])
    doc = await getSession(id)
    expect(doc!.status).toBe('completed')
    expect(doc!.totalTokens).toBe(150)
    // startedAt stays the execution anchor → billing meters [10:10, 10:11] = 1
    // min, NOT [10:00, 10:11] = 11 min (queue wait never billed). G1.
    expect(doc!.startedAt?.getTime()).toBe(ranAt.getTime())
  })

  it('LANDS a session.delta on a still-queued session (TER-691: no status guard)', async () => {
    const id = nextId('usess')
    const at = new Date('2026-05-20T10:00:00Z')
    // The `session.running` event was lost, but the turn DID work — the delta
    // carries real usage and must be recorded for observability. A queued session
    // that never anchors (startedAt null) bills 0 hours anyway, and the reconciler
    // later closes an orphan as reconciled_timeout → isNonBillableSession keeps it
    // out of billing. Dropping the delta only cost us the observability, never the
    // phantom billing (that is guarded downstream, not here).
    await applier.applyBatch([startedEvent(id, at), deltaEvent(id, at)])
    const doc = await getSession(id)
    // Mutation: re-add `{status:'running'}` to onSessionDelta → the $inc is
    // dropped → totalTokens=0 → this goes red.
    expect(doc!.totalTokens).toBe(150)
    expect(doc!.status).toBe('queued') // delta records usage; it never transitions status
  })

  it('LANDS a session.delta that arrives AFTER close (TER-691: real production order)', async () => {
    const id = nextId('usess')
    const at = new Date('2026-05-20T10:00:00Z')
    // Reproduces the EXACT production emission order. `session.ended` is ALWAYS
    // applied before `session.delta`: the onMessageComplete callback that emits
    // the delta is fire-and-forget (its promise is not collected by
    // flushCallbacks), so message-handler's `finally` calls end() before the delta
    // is even emitted — and the two can land in different buffer flushes (below,
    // separate applyBatch calls). The delta carries the turn's real
    // tokens/cost/latency and MUST land on the closed session, or
    // agent_usage_sessions stays at 0 (Model Health blank, rollup under-count).
    // RC1 of TER-691 — the guard TER-650/bd1e4a49 added dropped it silently.
    await applier.applyBatch([
      startedEvent(id, at),
      runningEvent(id, at),
      endedEvent(id, at), // ended FIRST — the production order
    ])
    await applier.applyBatch([deltaEvent(id, at)]) // delta in a LATER flush
    const doc = await getSession(id)
    expect(doc!.status).toBe('completed')
    // Mutation: re-add `{status:'running'}` → delta dropped → these go red.
    expect(doc!.totalTokens).toBe(150)
    expect(doc!.llmCallCount).toBe(1)
    expect(doc!.costUsd).toBeCloseTo(0.01)
  })

  it('LANDS latency/ttft/usagePartial from a post-close delta (TER-691: Model Health blank)', async () => {
    const id = nextId('usess')
    const at = new Date('2026-05-20T10:00:00Z')
    // The reported symptom: Model Health blank (no latency samples) despite heavy
    // traffic. The live fold reads session.latencyMs/ttftMs — which the dropped
    // delta never wrote. Assert the telemetry $set lands too, on a closed session.
    // Figures mirror a real divergent prod session (in=32457,out=645).
    const richDelta = {
      eventId: nextId('usev'),
      sessionUsageId: id,
      type: 'session.delta',
      payload: {
        inputTokens: 32457,
        outputTokens: 645,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.0334,
        llmCallCount: 1,
        toolCallCount: 0,
        latencyMs: 8123,
        ttftMs: 412,
        usagePartial: false,
        actualProvider: 'fireworks',
        actualModel: 'kimi-k2p6',
      },
      appliedAt: at,
      schemaVersion: 1,
    } as AgentUsageEvent
    await applier.applyBatch([startedEvent(id, at), runningEvent(id, at), endedEvent(id, at)])
    await applier.applyBatch([richDelta])
    const doc = await getSession(id)
    expect(doc!.totalTokens).toBe(33102) // 32457 + 0 + 645
    expect(doc!.latencyMs).toBe(8123)
    expect(doc!.ttftMs).toBe(412)
    expect(doc!.usagePartial).toBe(false)
    expect(doc!.actualProvider).toBe('fireworks')
  })

  it('can end straight from queued (cancelled before it ever ran) — startedAt stays null', async () => {
    const id = nextId('usess')
    const at = new Date('2026-05-20T10:00:00Z')
    await applier.applyBatch([startedEvent(id, at), endedEvent(id, at, 'aborted')])
    const doc = await getSession(id)
    expect(doc!.status).toBe('aborted')
    expect(doc!.startedAt).toBeNull()
  })
})

describe('reconciler — deadline-derived dual cutoff (TER-650/G1)', () => {
  function makeReconciler() {
    return new AgentUsageReconciler(sessions, tools, stubLogger, null, RECONCILE_OPTS)
  }

  it('does NOT close a running turn younger than the deadline threshold (35 min)', async () => {
    const id = nextId('usess')
    // 20 min into execution — a legitimate long turn, well under 35 min.
    await insertSession({ sessionUsageId: id, status: 'running', startedAt: new Date(Date.now() - 20 * MIN) })
    const res = await makeReconciler().runOnce()
    expect(res.sessionsClosed).toBe(0)
    const doc = await getSession(id)
    // Mutation: revert staleThresholdMin to the old hardcoded 15 → this live
    // turn is closed as reconciled_timeout → made $0 by the safety net → RED.
    expect(doc!.status).toBe('running')
  })

  it('closes an execution-orphan (running past the threshold) as reconciled_timeout', async () => {
    const id = nextId('usess')
    await insertSession({ sessionUsageId: id, status: 'running', startedAt: new Date(Date.now() - 40 * MIN) })
    const res = await makeReconciler().runOnce()
    expect(res.sessionsClosed).toBe(1)
    const doc = await getSession(id)
    expect(doc!.status).toBe('timed_out')
    expect(doc!.errorKind).toBe('reconciled_timeout')
    expect(doc!.durationMs).toBeGreaterThan(0)
  })

  it('closes a queue-orphan (queued past the threshold) with durationMs 0, startedAt null', async () => {
    const id = nextId('usess')
    await insertSession({
      sessionUsageId: id,
      status: 'queued',
      startedAt: null,
      createdAt: new Date(Date.now() - 40 * MIN),
    })
    const res = await makeReconciler().runOnce()
    expect(res.sessionsClosed).toBe(1)
    const doc = await getSession(id)
    expect(doc!.status).toBe('timed_out')
    expect(doc!.errorKind).toBe('reconciled_timeout')
    // Never executed → zero duration → non-billable, can never bill queue wait.
    expect(doc!.durationMs).toBe(0)
    expect(doc!.startedAt).toBeNull()
  })

  it('does NOT close a freshly-queued session (worker just has not drained it yet)', async () => {
    const id = nextId('usess')
    await insertSession({
      sessionUsageId: id,
      status: 'queued',
      startedAt: null,
      createdAt: new Date(Date.now() - 2 * MIN),
    })
    const res = await makeReconciler().runOnce()
    expect(res.sessionsClosed).toBe(0)
    const doc = await getSession(id)
    expect(doc!.status).toBe('queued')
  })
})

describe('billing rollup — coalesced sessions union to ~1 interval (TER-650/G4)', () => {
  it('N sessions sharing the same execution window bill once, not N times', async () => {
    const rollup = new AgentUsageRollupJob(db, stubLogger, null)
    const hour = new Date('2026-05-20T10:00:00Z')
    const start = new Date('2026-05-20T10:00:00Z')
    const end = new Date('2026-05-20T10:20:00Z') // 20 min execution window

    // Three coalesced turns (same user+workspace, same execution window) — the
    // ChannelWorker batches them into one turn, so all three flip to running at
    // the same execStart and end together. Only the last carried tokens.
    for (let i = 0; i < 3; i++) {
      await insertSession({
        sessionUsageId: nextId('usess'),
        status: 'completed',
        startedAt: start,
        endedAt: end,
        durationMs: 20 * MIN,
        inputTokens: i === 2 ? 100 : 0,
        outputTokens: i === 2 ? 50 : 0,
        totalTokens: i === 2 ? 150 : 0,
      })
    }

    await rollup.processHour(hour)
    const userRollup = await db
      .collection('agent_usage_rollups_user_hourly')
      .findOne({ hourBucket: hour, 'groupKey.userId': 'user_1' })

    // Union of three identical [10:00,10:20] intervals = 20 min, NOT 60 min.
    // Mutation: if billing summed per-session wall-clock instead of unioning →
    // 3_600_000 → RED. This is the coalescing dedupe (G4).
    expect(userRollup!.userActiveMs).toBe(20 * MIN)
  })

  it('excludes a queued-then-reconciled session from billing (null startedAt + non-billable)', async () => {
    const rollup = new AgentUsageRollupJob(db, stubLogger, null)
    const hour = new Date('2026-05-20T11:00:00Z')

    // A real billable turn in the hour.
    await insertSession({
      sessionUsageId: nextId('usess'),
      status: 'completed',
      startedAt: new Date('2026-05-20T11:05:00Z'),
      endedAt: new Date('2026-05-20T11:06:00Z'),
      durationMs: MIN,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
    // A queue-orphan closed by the reconciler: never ran, startedAt null.
    await insertSession({
      sessionUsageId: nextId('usess'),
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      startedAt: null,
      endedAt: new Date('2026-05-20T11:40:00Z'),
      durationMs: 0,
    })

    await rollup.processHour(hour)
    const userRollup = await db
      .collection('agent_usage_rollups_user_hourly')
      .findOne({ hourBucket: hour, 'groupKey.userId': 'user_1' })

    // Only the real 1-min turn bills; the queue-orphan contributes nothing.
    expect(userRollup!.userActiveMs).toBe(MIN)
    expect(userRollup!.sessionCount).toBe(1)
  })

  it('excludes a reconciled zombie with a full window AND landed tokens (TER-691 late delta × TER-650)', async () => {
    const rollup = new AgentUsageRollupJob(db, stubLogger, null)
    const hour = new Date('2026-05-20T12:00:00Z')

    // A real billable turn.
    await insertSession({
      sessionUsageId: nextId('usess'),
      status: 'completed',
      startedAt: new Date('2026-05-20T12:05:00Z'),
      endedAt: new Date('2026-05-20T12:06:00Z'),
      durationMs: MIN,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
    // A hung turn the reconciler closed as reconciled_timeout with a FULL
    // wall-clock window — and, post-TER-691, a late delta landed real tokens on
    // it (the guard no longer drops the delta). It MUST still be excluded from
    // billing purely by errorKind. This is the phantom-billing incident TER-650
    // guarded against; TER-691 (delta lands on terminal sessions) must NOT reopen
    // it. If it were billed, the zombie's 20 min would inflate userActiveMs to 21.
    await insertSession({
      sessionUsageId: nextId('usess'),
      status: 'timed_out',
      errorKind: 'reconciled_timeout',
      startedAt: new Date('2026-05-20T12:10:00Z'),
      endedAt: new Date('2026-05-20T12:30:00Z'),
      durationMs: 20 * MIN,
      inputTokens: 4000,
      outputTokens: 321,
      totalTokens: 4321,
    })

    await rollup.processHour(hour)
    const userRollup = await db
      .collection('agent_usage_rollups_user_hourly')
      .findOne({ hourBucket: hour, 'groupKey.userId': 'user_1' })

    // Only the real 1-min turn bills; the zombie's 20 min + 4321 tokens are
    // excluded by isNonBillableSession(reconciled_timeout), independent of tokens.
    // Mutation: drop the errorKind branch of isNonBillableSession → 21 min → RED.
    expect(userRollup!.userActiveMs).toBe(MIN)
    expect(userRollup!.sessionCount).toBe(1)
  })
})
