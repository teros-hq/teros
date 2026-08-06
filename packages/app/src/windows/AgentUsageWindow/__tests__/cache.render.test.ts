/**
 * cache.ts — per-agent / per-provider cache aggregation (pure). Asserts the
 * exact hit-ratio math and that cache status comes from the CANONICAL registry
 * (resolveProvider), so the panel can degrade honestly (`off` ≠ "0 % hit").
 */

import { describe, expect, it } from 'vitest'
import type { AgentUsageSessionSummary } from '../../../services/AdminApi'
import { cacheHitRatio, cacheMetrics } from '../cache'

function session(
  agentId: string,
  provider: string,
  input: number,
  cachedReadTokens: number,
  extra: Partial<AgentUsageSessionSummary> = {},
): AgentUsageSessionSummary {
  return {
    agentId,
    provider,
    modelId: 'm',
    inputTokens: input,
    outputTokens: 0,
    cachedReadTokens,
    costUsd: 0,
    ...extra,
  } as unknown as AgentUsageSessionSummary
}

const NAMES = new Map([
  ['a1', 'Agent One'],
  ['a2', 'Agent Two'],
])

describe('cacheHitRatio', () => {
  it('is cacheRead / (input + cacheRead) × 100, 0 on empty', () => {
    expect(cacheHitRatio(500, 1500)).toBe(25)
    expect(cacheHitRatio(0, 0)).toBe(0) // no division by zero
    expect(cacheHitRatio(0, 1000)).toBe(0)
  })
})

describe('cacheMetrics', () => {
  const sessions = [
    session('a1', 'anthropic', 1000, 500, { cachedWriteTokens: 100, outputTokens: 200, costUsd: 0.5 }),
    session('a1', 'anthropic', 2000, 0, { outputTokens: 300, costUsd: 0.3 }),
    session('a2', 'fireworks', 500, 0, { outputTokens: 50 }),
  ]

  it('aggregates totals + overall hit ratio', () => {
    const m = cacheMetrics(sessions, NAMES)
    expect(m.totalInput).toBe(3500)
    expect(m.totalCacheRead).toBe(500)
    expect(m.totalCacheWrite).toBe(100)
    expect(m.totalOutput).toBe(550)
    expect(m.totalIngested).toBe(4000)
    expect(m.totalCostUsd).toBeCloseTo(0.8, 6)
    expect(m.cacheHitRatio).toBe(12.5) // 500 / 4000
  })

  it('per-provider carries the registry cacheSupport (not a local guess)', () => {
    const m = cacheMetrics(sessions, NAMES)
    // Sorted by ingested desc → anthropic (3500) before fireworks (500).
    expect(m.perProvider.map((p) => p.provider)).toEqual(['anthropic', 'fireworks'])
    const anthropic = m.perProvider[0]
    expect(anthropic.cacheSupport).toBe('active')
    expect(anthropic.cacheNote).toBe('Prompt caching on')
    expect(anthropic.hitRatio).toBeCloseTo((500 / 3500) * 100, 6)
    // fireworks runs through OpenAICompatible → `auto` (TER-666); its 0 cacheRead
    // still reads "not measured" until real cached traffic arrives.
    expect(m.perProvider[1].cacheSupport).toBe('auto')
    expect(m.perProvider[1].hitRatio).toBe(0)
  })

  it('per-agent sorted by hit ratio, names resolved', () => {
    const m = cacheMetrics(sessions, NAMES)
    expect(m.perAgent.map((a) => a.agentName)).toEqual(['Agent One', 'Agent Two'])
    expect(m.perAgent[0].hitRatio).toBeCloseTo((500 / 3500) * 100, 6)
    expect(m.perAgent[1].hitRatio).toBe(0)
  })
})

describe('measured vs unmeasured sessions (P2/N8, 2026-07-07 audit)', () => {
  it('counts usagePartial and 0/0-token sessions as unmeasured, per total and per provider', () => {
    const m = cacheMetrics(
      [
        session('a1', 'anthropic', 1500, 500, { outputTokens: 10 }), // measured
        session('a1', 'teros', 0, 0, { usagePartial: true }), // flagged unmeasured
        session('a2', 'teros', 0, 0), // legacy row without the flag: 0/0 → unmeasured
      ],
      NAMES,
    )
    expect(m.sessionsCount).toBe(3)
    expect(m.measuredSessions).toBe(1)
    expect(m.unmeasuredSessions).toBe(2)
    const teros = m.perProvider.find((p) => p.provider === 'teros')!
    const anthropic = m.perProvider.find((p) => p.provider === 'anthropic')!
    expect(teros.sessions).toBe(2)
    expect(teros.measuredSessions).toBe(0)
    expect(anthropic.measuredSessions).toBe(1)
  })

  it('a session with input tokens but no flag counts as measured', () => {
    const m = cacheMetrics([session('a1', 'zhipu-coding', 800, 0)], NAMES)
    expect(m.measuredSessions).toBe(1)
    expect(m.unmeasuredSessions).toBe(0)
  })
})
