/**
 * AgentUsageReconciler — stale close + batch-saturation signal (TER-650).
 *
 * The reconciler closes `running` sessions/tools older than the cutoff, capped
 * at RECONCILE_BATCH_LIMIT per tick so a pathological backlog can't load
 * unbounded. When a batch hits that cap we must (a) still make progress and
 * (b) surface a warning + metric — otherwise a mass hang stays invisible behind
 * the bounded query. These tests pin both.
 */

import { describe, expect, it } from 'bun:test'
import {
  AgentUsageReconciler,
  DEFAULT_RECONCILER_OPTS,
  RECONCILE_BATCH_LIMIT,
} from '../../src/services/agent-usage-reconciler'

const stubLogger = () => {
  const warns: unknown[][] = []
  const logger = {
    info: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args)
    },
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => logger,
  } as any
  return { logger, warns }
}

function makeCursor<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const it of items) yield it
    },
    async close() {},
  }
}

/** Fake session repo: findStale yields `docs` (capped like Mongo would), update true. */
function fakeSessions(docs: any[], queuedDocs: any[] = []) {
  const updates: Array<{ id: string; update: any; filter: any }> = []
  const repo = {
    findStale: (_cutoff: Date, limit = RECONCILE_BATCH_LIMIT) => makeCursor(docs.slice(0, limit)),
    findStaleQueued: (_cutoff: Date, limit = RECONCILE_BATCH_LIMIT) =>
      makeCursor(queuedDocs.slice(0, limit)),
    update: async (id: string, update: any, filter: any) => {
      updates.push({ id, update, filter })
      return true
    },
    updates,
  }
  return repo as any
}

function fakeTools(docs: any[]) {
  return {
    findStale: (_cutoff: Date, limit = RECONCILE_BATCH_LIMIT) => makeCursor(docs.slice(0, limit)),
    update: async () => true,
  } as any
}

function session(i: number) {
  return { sessionUsageId: `usess_${i}`, startedAt: new Date('2026-01-01T00:00:00Z') }
}
/** A queue-orphan: never ran, so startedAt is null (createdAt drives its cutoff). */
function queuedSession(i: number) {
  return { sessionUsageId: `usess_q${i}`, startedAt: null }
}
function tool(i: number) {
  return { toolExecutionId: `tex_${i}`, startedAt: new Date('2026-01-01T00:00:00Z') }
}

describe('AgentUsageReconciler — stale close', () => {
  it('closes every stale session and tool and reports the counts', async () => {
    const { logger } = stubLogger()
    const r = new AgentUsageReconciler(
      fakeSessions([session(1), session(2), session(3)]),
      fakeTools([tool(1)]),
      logger,
      null,
      DEFAULT_RECONCILER_OPTS,
    )
    const res = await r.runOnce()
    expect(res).toEqual({ sessionsClosed: 3, toolsClosed: 1 })
    expect(r.getMetrics().reconcile_batch_saturated).toBe(0)
  })

  it('closes BOTH execution-orphans (running) and queue-orphans (queued) (TER-650/G1)', async () => {
    const { logger } = stubLogger()
    const sessions = fakeSessions([session(1), session(2)], [queuedSession(1)])
    const r = new AgentUsageReconciler(sessions, fakeTools([]), logger, null, DEFAULT_RECONCILER_OPTS)
    const res = await r.runOnce()
    // 2 running + 1 queued = 3 sessions closed.
    expect(res.sessionsClosed).toBe(3)

    const execClose = sessions.updates.find((u: any) => u.id === 'usess_1')
    const queueClose = sessions.updates.find((u: any) => u.id === 'usess_q1')

    // Execution-orphan: guarded on {status:'running'}, real wall-clock duration.
    expect(execClose.filter).toEqual({ status: 'running' })
    expect(execClose.update.$set.status).toBe('timed_out')
    expect(execClose.update.$set.errorKind).toBe('reconciled_timeout')
    expect(execClose.update.$set.durationMs).toBeGreaterThan(0)

    // Queue-orphan: guarded on {status:'queued'}, NEVER ran → durationMs=0 (so it
    // can never bill queue-wait). Mutation: guard on 'running' or durationMs>0 → red.
    expect(queueClose.filter).toEqual({ status: 'queued' })
    expect(queueClose.update.$set.status).toBe('timed_out')
    expect(queueClose.update.$set.errorKind).toBe('reconciled_timeout')
    expect(queueClose.update.$set.durationMs).toBe(0)
  })
})

describe('AgentUsageReconciler — batch saturation (TER-650)', () => {
  it('does NOT warn or count saturation for a batch below the cap', async () => {
    const { logger, warns } = stubLogger()
    const r = new AgentUsageReconciler(
      fakeSessions([session(1), session(2)]),
      fakeTools([]),
      logger,
      null,
      DEFAULT_RECONCILER_OPTS,
    )
    await r.runOnce()
    expect(r.getMetrics().reconcile_batch_saturated).toBe(0)
    expect(warns).toHaveLength(0)
  })

  it('warns + counts saturation when a session batch hits the cap (backlog remains)', async () => {
    const { logger, warns } = stubLogger()
    const full = Array.from({ length: RECONCILE_BATCH_LIMIT }, (_v, i) => session(i))
    const r = new AgentUsageReconciler(
      fakeSessions(full),
      fakeTools([]),
      logger,
      null,
      DEFAULT_RECONCILER_OPTS,
    )
    await r.runOnce()
    // Progress is still made (all closed) AND the saturation is surfaced.
    expect(r.getMetrics().reconcile_sessions_closed).toBe(RECONCILE_BATCH_LIMIT)
    expect(r.getMetrics().reconcile_batch_saturated).toBe(1)
    // The warn carries the actionable payload (seen === limit).
    const payload = warns[0]?.[0] as { seen: number; limit: number }
    expect(payload.seen).toBe(RECONCILE_BATCH_LIMIT)
    expect(payload.limit).toBe(RECONCILE_BATCH_LIMIT)
  })

  it('counts saturation for a full tool batch too', async () => {
    const { logger } = stubLogger()
    const full = Array.from({ length: RECONCILE_BATCH_LIMIT }, (_v, i) => tool(i))
    const r = new AgentUsageReconciler(
      fakeSessions([]),
      fakeTools(full),
      logger,
      null,
      DEFAULT_RECONCILER_OPTS,
    )
    await r.runOnce()
    expect(r.getMetrics().reconcile_batch_saturated).toBe(1)
  })
})
