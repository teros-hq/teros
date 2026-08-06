/**
 * Unit tests for AgentUsageEventApplier.
 *
 * Mocks the three repositories with minimal fakes so we can assert exactly
 * the side effects (which collections get touched, with which payloads) for
 * each event type.
 *
 * Critical guard validated here: when `session.ended` is reapplied on a doc
 * that is already in a terminal status, the applier MUST NOT propagate
 * descendant counters to the parent again (M1). The guard relies on the
 * `sessions.update` returning `false` for `matchedCount === 0`.
 */

import { describe, expect, it, mock } from 'bun:test'
import { AgentUsageEventApplier } from '../../src/services/agent-usage-event-applier'
import type {
  AgentUsageEvent,
  SessionEndedPayload,
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

interface AppliedEvent {
  collection: 'sessions' | 'tools'
  op: 'insert' | 'update'
  id: string
  payload: any
  filter?: any
}

function makeFakes(opts?: {
  claimReturns?: (eventId: string) => Promise<boolean>
  sessionsUpdateReturns?: (
    id: string,
    update: any,
    filter?: any,
  ) => Promise<boolean>
  toolsUpdateReturns?: (id: string, update: any, filter?: any) => Promise<boolean>
  sessionsFindByIdReturns?: (id: string) => Promise<any>
}) {
  const applied: AppliedEvent[] = []
  const claims = new Set<string>()

  const applications = {
    async tryClaim(eventId: string) {
      if (opts?.claimReturns) return opts.claimReturns(eventId)
      if (claims.has(eventId)) return false
      claims.add(eventId)
      return true
    },
  } as any

  const sessions = {
    async insert(doc: any) {
      applied.push({ collection: 'sessions', op: 'insert', id: doc.sessionUsageId, payload: doc })
      return true
    },
    async update(id: string, update: any, filter?: any) {
      applied.push({ collection: 'sessions', op: 'update', id, payload: update, filter })
      if (opts?.sessionsUpdateReturns) return opts.sessionsUpdateReturns(id, update, filter)
      return true
    },
    async findById(id: string) {
      if (opts?.sessionsFindByIdReturns) return opts.sessionsFindByIdReturns(id)
      return {
        sessionUsageId: id,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.01,
        descendantInputTokens: 0,
        descendantOutputTokens: 0,
        descendantCostUsd: 0,
        descendantSessionCount: 0,
      }
    },
  } as any

  const tools = {
    async insert(doc: any) {
      applied.push({ collection: 'tools', op: 'insert', id: doc.toolExecutionId, payload: doc })
      return true
    },
    async update(id: string, update: any, filter?: any) {
      applied.push({ collection: 'tools', op: 'update', id, payload: update, filter })
      if (opts?.toolsUpdateReturns) return opts.toolsUpdateReturns(id, update, filter)
      return true
    },
  } as any

  return { applications, sessions, tools, applied }
}

const sessionStartedEvent: AgentUsageEvent = {
  eventId: 'usev_001',
  sessionUsageId: 'usess_aaa',
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
    startedAt: new Date('2026-05-20T10:00:00Z'),
  },
  appliedAt: new Date('2026-05-20T10:00:00Z'),
  schemaVersion: 1,
}

function sessionRunningEvent(startedAt: Date): AgentUsageEvent {
  return {
    eventId: 'usev_run',
    sessionUsageId: 'usess_aaa',
    type: 'session.running',
    payload: { startedAt },
    appliedAt: startedAt,
    schemaVersion: 1,
  }
}

const sessionDeltaEvent: AgentUsageEvent = {
  eventId: 'usev_002',
  sessionUsageId: 'usess_aaa',
  type: 'session.delta',
  payload: {
    inputTokens: 100,
    outputTokens: 50,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    llmCallCount: 1,
    toolCallCount: 0,
  },
  appliedAt: new Date('2026-05-20T10:00:05Z'),
  schemaVersion: 1,
}

function sessionEndedEvent(parentSessionUsageId: string | null = null): AgentUsageEvent {
  const payload: SessionEndedPayload = {
    endedAt: new Date('2026-05-20T10:00:10Z'),
    durationMs: 10_000,
    durationSource: 'monotonic',
    status: 'completed',
    parentSessionUsageId,
  }
  return {
    eventId: 'usev_003',
    sessionUsageId: 'usess_aaa',
    type: 'session.ended',
    payload,
    appliedAt: new Date('2026-05-20T10:00:10Z'),
    schemaVersion: 1,
  }
}

describe('AgentUsageEventApplier', () => {
  it('applies session.started by inserting a QUEUED doc with no execution anchor (TER-650/G1)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const count = await applier.applyBatch([sessionStartedEvent])
    expect(count).toBe(1)
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ collection: 'sessions', op: 'insert', id: 'usess_aaa' })
    // The session opens `queued` with startedAt=null — it does NOT bill until
    // session.running anchors it. Mutation: revert to status:'running'/startedAt
    // set → red (this is the whole G1 lifecycle change).
    expect(applied[0].payload.status).toBe('queued')
    expect(applied[0].payload.startedAt).toBeNull()
  })

  it('session.running flips queued→running and sets the execution anchor (TER-650/G1)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const runningAt = new Date('2026-05-20T10:00:04Z')
    await applier.applyBatch([sessionRunningEvent(runningAt)])
    const updates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(updates).toHaveLength(1)
    // Guarded on {status:'queued'} so it can't revive a closed session.
    expect(updates[0].filter).toEqual({ status: 'queued' })
    expect(updates[0].payload.$set.status).toBe('running')
    expect(updates[0].payload.$set.startedAt).toEqual(runningAt)
  })

  it('session.running clamps a future startedAt to appliedAt so it stays reconcilable (TER-650)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const appliedAt = new Date('2026-05-20T10:00:00Z')
    const futureStart = new Date('2026-05-20T10:05:00Z') // 5 min ahead (clock skew)
    await applier.applyBatch([
      {
        ...sessionRunningEvent(futureStart),
        eventId: 'usev_future',
        sessionUsageId: 'usess_future',
        appliedAt,
      },
    ])
    const update = applied.find((a) => a.id === 'usess_future')!
    // Clamped to appliedAt — a future startedAt would sit forever above the
    // reconciler's `startedAt < cutoff` filter and leak as an eternal zombie.
    expect(update.payload.$set.startedAt).toEqual(appliedAt)
  })

  it('session.running leaves a normal (past-or-equal) startedAt untouched', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const runningAt = new Date('2026-05-20T10:00:04Z')
    await applier.applyBatch([sessionRunningEvent(runningAt)]) // startedAt === appliedAt
    const update = applied.find((a) => a.id === 'usess_aaa')!
    expect(update.payload.$set.startedAt).toEqual(runningAt)
  })

  it('seeds actualProvider/actualModel from the started payload (TER-616/C1)', async () => {
    // An error/timeout turn never emits session.delta; without seeding the
    // upstream here it would bucket under the `teros` alias, hiding the
    // Fireworks error-rate. The applier MUST persist the seed.
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_teros',
      sessionUsageId: 'usess_teros',
      type: 'session.started',
      payload: {
        parentSessionUsageId: null,
        triggerKind: 'user_message',
        userId: 'user_1',
        agentId: 'agent_1',
        workspaceId: 'work_1',
        channelId: 'ch_1',
        provider: 'teros' as any,
        modelId: 'teros-kimi-k2.6',
        actualProvider: 'fireworks',
        actualModel: 'accounts/fireworks/models/kimi-k2p6',
        startedAt: new Date('2026-05-20T10:00:00Z'),
      },
      appliedAt: new Date('2026-05-20T10:00:00Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    const doc = applied[0].payload
    // Mutation: reverting to `actualProvider: undefined` (the pre-R1 bug) → red.
    expect(doc.actualProvider).toBe('fireworks')
    expect(doc.actualModel).toBe('accounts/fireworks/models/kimi-k2p6')
  })

  it('leaves actualProvider/actualModel undefined for providers without an upstream split', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    await applier.applyBatch([sessionStartedEvent]) // anthropic fixture, no seed
    const doc = applied[0].payload
    expect(doc.actualProvider).toBeUndefined()
    expect(doc.actualModel).toBeUndefined()
  })

  it('applies session.delta with $inc and NO status filter (TER-691: order-independent)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    await applier.applyBatch([sessionDeltaEvent])
    expect(applied).toHaveLength(1)
    expect(applied[0].collection).toBe('sessions')
    expect(applied[0].op).toBe('update')
    expect(applied[0].payload.$inc.inputTokens).toBe(100)
    expect(applied[0].payload.$inc.outputTokens).toBe(50)
    // No status guard: `session.ended` is applied before `session.delta` on the
    // real path, so a `{status:"running"}` filter dropped the $inc on every
    // completed turn. The delta must land regardless of status; idempotency is
    // guaranteed by tryClaim, and phantom billing by isNonBillableSession
    // (errorKind) downstream — NOT by this filter. Behavioral proof (delta lands
    // after close) lives in agent-usage-lifecycle-g1.test.ts against real Mongo.
    // Mutation: re-add `{status:"running"}` here → toBeUndefined goes red.
    expect(applied[0].filter).toBeUndefined()
  })

  it('applies session.ended for top-level turn (no parent) without propagating', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    await applier.applyBatch([sessionEndedEvent(null)])
    // exactly one update on sessions (the child close); NO parent update
    const updates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0].filter).toEqual({ status: { $in: ['queued', 'running'] } })
    // and no findById should have been needed
  })

  it('persists errorKind + errorSubReason + upstreamMessage on session.ended (TER-698)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const ev = sessionEndedEvent(null)
    ;(ev.payload as SessionEndedPayload).status = 'errored'
    ;(ev.payload as SessionEndedPayload).errorKind = 'rate_limited'
    ;(ev.payload as SessionEndedPayload).errorSubReason = 'provider_capacity'
    ;(ev.payload as SessionEndedPayload).upstreamMessage =
      '429 rate limit exceeded, please try again later'
    await applier.applyBatch([ev])
    const update = applied.find((a) => a.collection === 'sessions' && a.op === 'update')!
    // The honest-attribution fields ride on the SAME $set as errorKind (all on
    // session.ended, order-independent). Mutation: drop the `set.errorSubReason`
    // line in onSessionEnded → red — proving the dashboard's source is wired.
    expect(update.payload.$set.errorKind).toBe('rate_limited')
    expect(update.payload.$set.errorSubReason).toBe('provider_capacity')
    expect(update.payload.$set.upstreamMessage).toContain('rate limit exceeded')
  })

  it('propagates descendant counters when the child close matches and there is a parent', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    await applier.applyBatch([sessionEndedEvent('usess_parent')])
    const updates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(updates).toHaveLength(2)
    // first: child close with filter status:running
    expect(updates[0].id).toBe('usess_aaa')
    expect(updates[0].filter).toEqual({ status: { $in: ['queued', 'running'] } })
    // second: parent $inc
    expect(updates[1].id).toBe('usess_parent')
    expect(updates[1].payload.$inc.descendantInputTokens).toBe(100)
    expect(updates[1].payload.$inc.descendantOutputTokens).toBe(50)
    expect(updates[1].payload.$inc.descendantSessionCount).toBe(1)
  })

  it('does NOT propagate descendant counters when the child update did not match (M1 guard)', async () => {
    // sessions.update returns false → child was already closed; skipping propagation
    const { applications, sessions, tools, applied } = makeFakes({
      sessionsUpdateReturns: async () => false,
    })
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    await applier.applyBatch([sessionEndedEvent('usess_parent')])
    const updates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(updates).toHaveLength(1) // only the child update, no parent $inc
    expect(updates[0].id).toBe('usess_aaa')
  })

  it('skips silently when tryClaim returns false (already applied)', async () => {
    const { applications, sessions, tools, applied } = makeFakes({
      claimReturns: async () => false,
    })
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const count = await applier.applyBatch([sessionStartedEvent, sessionDeltaEvent])
    expect(count).toBe(0)
    expect(applied).toHaveLength(0)
  })

  it('applies tool.started by inserting tool_executions', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_004',
      sessionUsageId: 'usess_aaa',
      toolExecutionId: 'tex_zzz',
      type: 'tool.started',
      payload: {
        channelId: 'ch_1',
        userId: 'user_1',
        agentId: 'agent_1',
        workspaceId: 'work_1',
        stepIndex: 0,
        toolCallIndex: 0,
        toolName: 'fs.read-file',
        startedAt: new Date('2026-05-20T10:00:03Z'),
      },
      appliedAt: new Date('2026-05-20T10:00:03Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ collection: 'tools', op: 'insert', id: 'tex_zzz' })
  })

  it('increments session.toolErrorCount on a failing tool.ended (TER-616/R4.3)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_toolerr',
      sessionUsageId: 'usess_aaa',
      toolExecutionId: 'tex_err',
      type: 'tool.ended',
      payload: {
        endedAt: new Date('2026-05-20T10:00:08Z'),
        durationMs: 10,
        durationSource: 'monotonic',
        status: 'error',
        errorMessage: 'boom',
      },
      appliedAt: new Date('2026-05-20T10:00:08Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    // The tool row close + a $inc onto the session doc (mutation: drop the $inc → none).
    const sessionUpdates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(sessionUpdates).toHaveLength(1)
    expect(sessionUpdates[0].id).toBe('usess_aaa')
    expect(sessionUpdates[0].payload.$inc.toolErrorCount).toBe(1)
  })

  it('does NOT increment toolErrorCount when the tool was already closed (A1.8 replay guard)', async () => {
    // Manual replay after `agent_usage_event_applications` was wiped: the event
    // is re-claimed, but the tool doc is already in `error` → tools.update does
    // not match. The $inc must be skipped, or toolErrorCount double-counts.
    const { applications, sessions, tools, applied } = makeFakes({
      toolsUpdateReturns: async () => false,
    })
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_toolerr_replay',
      sessionUsageId: 'usess_aaa',
      toolExecutionId: 'tex_err',
      type: 'tool.ended',
      payload: {
        endedAt: new Date('2026-05-20T10:00:08Z'),
        durationMs: 10,
        durationSource: 'monotonic',
        status: 'error',
        errorMessage: 'boom',
      },
      appliedAt: new Date('2026-05-20T10:00:08Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    // The tool update was attempted, but NO session $inc (mutation: drop `&& matched` → red).
    const sessionUpdates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(sessionUpdates).toHaveLength(0)
  })

  it('does NOT touch toolErrorCount on a successful tool.ended', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_toolok',
      sessionUsageId: 'usess_aaa',
      toolExecutionId: 'tex_ok',
      type: 'tool.ended',
      payload: {
        endedAt: new Date('2026-05-20T10:00:08Z'),
        durationMs: 10,
        durationSource: 'monotonic',
        status: 'success',
        outputSizeBytes: 100,
      },
      appliedAt: new Date('2026-05-20T10:00:08Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    const sessionUpdates = applied.filter((a) => a.collection === 'sessions' && a.op === 'update')
    expect(sessionUpdates).toHaveLength(0)
  })

  it('projects stopReason/fallbackUsed/primaryErrorClass from session.delta (R4 + F3)', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_delta2',
      sessionUsageId: 'usess_aaa',
      type: 'session.delta',
      payload: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        llmCallCount: 1,
        toolCallCount: 0,
        stopReason: 'length',
        fallbackUsed: true,
        primaryErrorClass: 'rate_limited',
      },
      appliedAt: new Date('2026-05-20T10:00:05Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    const set = applied[0].payload.$set
    expect(set.stopReason).toBe('length')
    expect(set.fallbackUsed).toBe(true)
    expect(set.primaryErrorClass).toBe('rate_limited')
  })

  it('applies tool.ended by updating the tool execution', async () => {
    const { applications, sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const event: AgentUsageEvent = {
      eventId: 'usev_005',
      sessionUsageId: 'usess_aaa',
      toolExecutionId: 'tex_zzz',
      type: 'tool.ended',
      payload: {
        endedAt: new Date('2026-05-20T10:00:08Z'),
        durationMs: 5_000,
        durationSource: 'monotonic',
        status: 'success',
        outputSizeBytes: 1024,
      },
      appliedAt: new Date('2026-05-20T10:00:08Z'),
      schemaVersion: 1,
    }
    await applier.applyBatch([event])
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ collection: 'tools', op: 'update', id: 'tex_zzz' })
    expect(applied[0].filter).toEqual({ status: 'running' })
  })

  it('continues processing the batch when one event throws', async () => {
    const events: AgentUsageEvent[] = [sessionStartedEvent, sessionDeltaEvent]
    const applications = {
      async tryClaim(eventId: string) {
        if (eventId === sessionStartedEvent.eventId) throw new Error('boom')
        return true
      },
    } as any
    const { sessions, tools, applied } = makeFakes()
    const applier = new AgentUsageEventApplier(applications, sessions, tools, stubLogger)
    const count = await applier.applyBatch(events)
    // delta succeeded; started failed and was logged but did not abort the batch
    expect(count).toBe(1)
    expect(applied).toHaveLength(1)
    expect(applied[0].collection).toBe('sessions')
    expect(applied[0].op).toBe('update')
  })
})
