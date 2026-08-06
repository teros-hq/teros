import { describe, expect, it } from 'bun:test'
import { percentile } from '../../src/services/latency-histogram'
import { RollupAccumulator } from '../../src/services/rollup-accumulator'
import type { AgentUsageSession } from '../../src/types/database'

const DOC_INPUT = {
  rollupId: 'usro_x',
  hourBucket: new Date('2026-05-20T10:00:00Z'),
  computedAt: new Date('2026-05-20T11:00:00Z'),
  jobRunId: 'usro_run',
}

function makeSession(overrides: Partial<AgentUsageSession> = {}): AgentUsageSession {
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
    startedAt: new Date('2026-05-20T10:00:00Z'),
    endedAt: new Date('2026-05-20T10:00:10Z'),
    durationMs: 10_000,
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

describe('RollupAccumulator', () => {
  it('fromSession captures the groupKey from the first session', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    expect(acc.groupKey).toEqual({
      userId: 'user_1',
      agentId: 'agent_1',
      provider: 'anthropic',
      workspaceId: 'work_1',
    })
  })

  it('add accumulates tokens, activeMs and counters', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    acc.add(makeSession(), 1.0, 10_000)
    const doc = acc.toDoc({
      rollupId: 'usro_x',
      hourBucket: new Date('2026-05-20T10:00:00Z'),
      computedAt: new Date('2026-05-20T11:00:00Z'),
      jobRunId: 'usro_run',
    })
    expect(doc.inputTokens).toBe(100)
    expect(doc.outputTokens).toBe(50)
    expect(doc.totalTokens).toBe(150)
    expect(doc.agentActiveMs).toBe(10_000)
    expect(doc.sessionCount).toBe(1)
    expect(doc.completedCount).toBe(1)
  })

  it('add applies fraction proportionally', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    acc.add(makeSession({ totalTokens: 300, costUsd: 0.02 }), 0.5, 1800_000)
    const doc = acc.toDoc({
      rollupId: 'usro_x',
      hourBucket: new Date('2026-05-20T10:00:00Z'),
      computedAt: new Date('2026-05-20T11:00:00Z'),
      jobRunId: 'usro_run',
    })
    expect(doc.totalTokens).toBe(150)
    expect(doc.costUsd).toBeCloseTo(0.01, 5)
    expect(doc.agentActiveMs).toBe(1800_000)
  })

  it('add tracks status counters across the four enum values', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    acc.add(makeSession({ status: 'completed' }), 1, 100)
    acc.add(makeSession({ status: 'errored' }), 1, 100)
    acc.add(makeSession({ status: 'timed_out' }), 1, 100)
    acc.add(makeSession({ status: 'aborted' }), 1, 100)
    const doc = acc.toDoc({
      rollupId: 'usro_x',
      hourBucket: new Date(),
      computedAt: new Date(),
      jobRunId: 'usro_run',
    })
    expect(doc.completedCount).toBe(1)
    expect(doc.erroredCount).toBe(1)
    expect(doc.timedOutCount).toBe(1)
    expect(doc.abortedCount).toBe(1)
    expect(doc.sessionCount).toBe(4)
  })

  it('add aggregates modelMix per actualModel (falling back to modelId)', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    acc.add(makeSession({ modelId: 'claude-sonnet-4-5', actualModel: undefined }), 1, 100)
    acc.add(
      makeSession({ modelId: 'claude-sonnet-4-5', actualModel: 'claude-sonnet-4-5-20251022' }),
      1,
      100,
    )
    acc.add(makeSession({ modelId: 'claude-haiku-4-5', actualModel: undefined }), 1, 100)
    const doc = acc.toDoc({
      rollupId: 'usro_x',
      hourBucket: new Date(),
      computedAt: new Date(),
      jobRunId: 'usro_run',
    })
    const models = Object.keys(doc.modelMix).sort()
    expect(models).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20251022',
    ])
    expect(doc.modelMix['claude-sonnet-4-5']!.sessionCount).toBe(1)
    expect(doc.modelMix['claude-sonnet-4-5-20251022']!.sessionCount).toBe(1)
    expect(doc.modelMix['claude-haiku-4-5']!.sessionCount).toBe(1)
  })

  it('toDoc embeds the rollupId, hourBucket and computedAt unchanged', () => {
    const acc = RollupAccumulator.fromSession(makeSession())
    acc.add(makeSession(), 1, 100)
    const hourBucket = new Date('2026-05-20T10:00:00Z')
    const computedAt = new Date('2026-05-20T11:00:00Z')
    const doc = acc.toDoc({
      rollupId: 'usro_abc',
      hourBucket,
      computedAt,
      jobRunId: 'usro_run',
    })
    expect(doc.rollupId).toBe('usro_abc')
    expect(doc.hourBucket).toBe(hourBucket)
    expect(doc.computedAt).toBe(computedAt)
    expect(doc.createdAt).toBe(computedAt)
    expect(doc.schemaVersion).toBe(1)
  })
})

describe('RollupAccumulator — modelHealth (TER-616 / F1)', () => {
  it('keys by actualProvider×modelId — distinguishes Fireworks from Together for the SAME model (C1)', () => {
    // Same logical provider `teros` and same model, different real upstream:
    // they MUST land under distinct keys or "which one degraded?" is unanswerable.
    const acc = RollupAccumulator.fromSession(
      makeSession({ provider: 'teros', actualProvider: 'fireworks', modelId: 'kimi-k2p6' }),
    )
    acc.add(
      makeSession({
        provider: 'teros',
        actualProvider: 'fireworks',
        modelId: 'kimi-k2p6',
        latencyMs: 1200,
        ttftMs: 300,
      }),
      1,
      100,
    )
    acc.add(
      makeSession({
        provider: 'teros',
        actualProvider: 'together',
        modelId: 'kimi-k2p6',
        latencyMs: 800,
        ttftMs: 200,
      }),
      1,
      100,
    )
    const doc = acc.toDoc(DOC_INPUT)
    expect(Object.keys(doc.modelHealth!).sort()).toEqual([
      'fireworks::kimi-k2p6',
      'together::kimi-k2p6',
    ])
    const fw = doc.modelHealth!['fireworks::kimi-k2p6']!
    expect(fw.actualProvider).toBe('fireworks')
    expect(fw.modelId).toBe('kimi-k2p6')
    expect(fw.requestCount).toBe(1)
    expect(fw.latency.count).toBe(1)
    expect(fw.ttft.count).toBe(1)
  })

  it('records latency/ttft into additive histograms (percentile derivable)', () => {
    const acc = RollupAccumulator.fromSession(makeSession({ actualProvider: 'fireworks', modelId: 'm' }))
    for (const l of [1200, 1200, 1200, 1200, 1200]) {
      acc.add(makeSession({ actualProvider: 'fireworks', modelId: 'm', latencyMs: l, ttftMs: 250 }), 1, 100)
    }
    const entry = acc.toDoc(DOC_INPUT).modelHealth!['fireworks::m']!
    expect(entry.requestCount).toBe(5)
    expect(entry.latency.count).toBe(5)
    expect(entry.latency.sum).toBe(6000)
    // 1200ms falls in bucket (640, 1280] → p50 interpolates inside it.
    const p50 = percentile(entry.latency, 50)!
    expect(p50).toBeGreaterThan(640)
    expect(p50).toBeLessThanOrEqual(1280)
    // TTFT histogram is independent: 250ms in (160, 320].
    expect(percentile(entry.ttft, 50)!).toBeLessThanOrEqual(320)
  })

  it('counts statusCounts + errorCounts (degradation breakdown by errorKind)', () => {
    const acc = RollupAccumulator.fromSession(makeSession({ actualProvider: 'fireworks', modelId: 'm' }))
    acc.add(makeSession({ actualProvider: 'fireworks', modelId: 'm', status: 'completed' }), 1, 100)
    acc.add(
      makeSession({ actualProvider: 'fireworks', modelId: 'm', status: 'errored', errorKind: 'rate_limited' }),
      1,
      100,
    )
    acc.add(
      makeSession({ actualProvider: 'fireworks', modelId: 'm', status: 'errored', errorKind: 'rate_limited' }),
      1,
      100,
    )
    acc.add(
      makeSession({ actualProvider: 'fireworks', modelId: 'm', status: 'errored', errorKind: 'server_error' }),
      1,
      100,
    )
    const entry = acc.toDoc(DOC_INPUT).modelHealth!['fireworks::m']!
    expect(entry.statusCounts.completed).toBe(1)
    expect(entry.statusCounts.errored).toBe(3)
    expect(entry.errorCounts.rate_limited).toBe(2)
    expect(entry.errorCounts.server_error).toBe(1)
    // A non-errored turn must NOT land in errorCounts.
    expect(entry.errorCounts.llm_error).toBeUndefined()
  })

  it('falls back to the logical provider when actualProvider is absent (legacy/non-OAI sessions)', () => {
    const acc = RollupAccumulator.fromSession(
      makeSession({ provider: 'anthropic', actualProvider: undefined, modelId: 'claude' }),
    )
    acc.add(makeSession({ provider: 'anthropic', actualProvider: undefined, modelId: 'claude' }), 1, 100)
    expect(Object.keys(acc.toDoc(DOC_INPUT).modelHealth!)).toEqual(['anthropic::claude'])
  })

  it('omits latency from the histogram when the session has no latencyMs (no phantom 0s)', () => {
    const acc = RollupAccumulator.fromSession(makeSession({ actualProvider: 'fireworks', modelId: 'm' }))
    acc.add(makeSession({ actualProvider: 'fireworks', modelId: 'm', latencyMs: undefined, ttftMs: undefined }), 1, 100)
    const entry = acc.toDoc(DOC_INPUT).modelHealth!['fireworks::m']!
    expect(entry.requestCount).toBe(1) // the turn still counts for throughput
    expect(entry.latency.count).toBe(0) // but not in the latency distribution
    expect(entry.ttft.count).toBe(0)
  })

  // C1/C2 (TER-616): a successful turn carries actualProvider from session.delta;
  // an errored/timed-out turn NEVER emits a delta, so it relies on the upstream
  // SEEDED into the doc at session.started (R1). Both must share ONE key so the
  // per-upstream error-rate is observable — the whole point of F1.
  it('buckets a teros success and a teros error under the SAME fireworks key (C1)', () => {
    const success = makeSession({
      provider: 'teros',
      modelId: 'teros-kimi-k2.6',
      actualProvider: 'fireworks', // projected from session.delta
      actualModel: 'accounts/fireworks/models/kimi-k2p6',
      status: 'completed',
    })
    const errored = makeSession({
      provider: 'teros',
      modelId: 'teros-kimi-k2.6',
      actualProvider: 'fireworks', // seeded at session.started (R1) — no delta
      actualModel: 'accounts/fireworks/models/kimi-k2p6',
      status: 'errored',
      errorKind: 'rate_limited',
    })
    const acc = RollupAccumulator.fromSession(success)
    acc.add(success, 1, 100)
    acc.add(errored, 1, 100)
    const health = acc.toDoc(DOC_INPUT).modelHealth!
    // ONE key, not two — no phantom `teros::teros-kimi-k2.6` split.
    expect(Object.keys(health)).toEqual(['fireworks::accounts/fireworks/models/kimi-k2p6'])
    const entry = health['fireworks::accounts/fireworks/models/kimi-k2p6']!
    expect(entry.requestCount).toBe(2)
    expect(entry.statusCounts.completed).toBe(1)
    expect(entry.statusCounts.errored).toBe(1)
    // The Fireworks error-rate is now observable (1 of 2).
    expect(entry.errorCounts.rate_limited).toBe(1)
  })

  it('WITHOUT the upstream seed an error splits into a phantom teros:: key (the C1 bug R1 fixes)', () => {
    const success = makeSession({
      provider: 'teros',
      modelId: 'teros-kimi-k2.6',
      actualProvider: 'fireworks',
      actualModel: 'accounts/fireworks/models/kimi-k2p6',
      status: 'completed',
    })
    // Pre-R1 reality: an errored turn reached the doc with NO actualProvider.
    const erroredUnseeded = makeSession({
      provider: 'teros',
      modelId: 'teros-kimi-k2.6',
      actualProvider: undefined,
      actualModel: undefined,
      status: 'errored',
      errorKind: 'rate_limited',
    })
    const acc = RollupAccumulator.fromSession(success)
    acc.add(success, 1, 100)
    acc.add(erroredUnseeded, 1, 100)
    const health = acc.toDoc(DOC_INPUT).modelHealth!
    // Two keys: the error hides under teros::teros-kimi-k2.6, invisible to the
    // Fireworks error-rate. This split is exactly what R1 eliminates.
    expect(Object.keys(health).sort()).toEqual([
      'fireworks::accounts/fireworks/models/kimi-k2p6',
      'teros::teros-kimi-k2.6',
    ])
    expect(
      health['fireworks::accounts/fireworks/models/kimi-k2p6']!.errorCounts.rate_limited,
    ).toBeUndefined()
  })

  it('accumulates finishReasons / emptyCount / tool counts under the upstream key (§3.1 + R4.3)', () => {
    const base = { actualProvider: 'fireworks', modelId: 'm' } as const
    const acc = RollupAccumulator.fromSession(makeSession(base))
    // normal completion ending on `stop`, ran 2 tools (1 failed)
    acc.add(
      makeSession({ ...base, status: 'completed', outputTokens: 50, stopReason: 'stop', toolCallCount: 2, toolErrorCount: 1 }),
      1,
      100,
    )
    // truncated completion (finish_reason=length → truncation proxy)
    acc.add(makeSession({ ...base, status: 'completed', outputTokens: 16384, stopReason: 'length' }), 1, 100)
    // empty completion (0 output tokens, reliable usage)
    acc.add(makeSession({ ...base, status: 'completed', outputTokens: 0, stopReason: 'stop' }), 1, 100)
    const e = acc.toDoc(DOC_INPUT).modelHealth!['fireworks::m']!
    expect(e.finishReasons).toEqual({ stop: 2, length: 1 })
    expect(e.emptyCount).toBe(1)
    expect(e.toolCallCount).toBe(2)
    expect(e.toolErrorCount).toBe(1)
  })

  it('does NOT count a partial-usage completion as empty (avoids false empties)', () => {
    const base = { actualProvider: 'fireworks', modelId: 'm' } as const
    const acc = RollupAccumulator.fromSession(makeSession(base))
    acc.add(makeSession({ ...base, status: 'completed', outputTokens: 0, usagePartial: true }), 1, 100)
    expect(acc.toDoc(DOC_INPUT).modelHealth!['fireworks::m']!.emptyCount).toBe(0)
  })

  it('counts a failover turn under the SERVING upstream (together) with fallbackCount (R3.4)', () => {
    const acc = RollupAccumulator.fromSession(makeSession({ actualProvider: 'together', modelId: 'm' }))
    acc.add(
      makeSession({ actualProvider: 'together', modelId: 'm', status: 'completed', outputTokens: 10, fallbackUsed: true, stopReason: 'stop' }),
      1,
      100,
    )
    expect(acc.toDoc(DOC_INPUT).modelHealth!['together::m']!.fallbackCount).toBe(1)
  })
})
