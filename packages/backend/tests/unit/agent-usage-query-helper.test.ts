import { describe, expect, it } from 'bun:test'
import {
  buildSessionsListPipeline,
  buildTokensPerHourPipeline,
  buildToolExecutionsListPipeline,
  coerceIdFilter,
  parseQuery,
} from '../../src/services/agent-usage-query-helper'

describe('coerceIdFilter (A6.2 NoSQL coercion)', () => {
  it('keeps a string, drops any non-string (NoSQL operator injection)', () => {
    expect(coerceIdFilter('user_1')).toBe('user_1')
    // Mutation: returning `v` unchanged leaks the operator object → red.
    expect(coerceIdFilter({ $ne: null })).toBeUndefined()
    expect(coerceIdFilter(undefined)).toBeUndefined()
    expect(coerceIdFilter(42)).toBeUndefined()
  })
})

const baseInput = {
  from: '2026-05-01T00:00:00Z',
  to: '2026-05-19T00:00:00Z',
  userId: 'user_1',
}

describe('parseQuery', () => {
  it('throws when from/to are missing', () => {
    expect(() => parseQuery({}, { allowEmptyFilters: true })).toThrow(/from and to/)
  })

  it('throws when from >= to', () => {
    expect(() =>
      parseQuery({ ...baseInput, from: '2026-05-19T00:00:00Z' }, { allowEmptyFilters: true }),
    ).toThrow(/from must be < to/)
  })

  it('throws when filters are required and missing', () => {
    expect(() =>
      parseQuery(
        { from: baseInput.from, to: baseInput.to },
        { allowEmptyFilters: false },
      ),
    ).toThrow(/At least one of/)
  })

  it('accepts a minimal valid query', () => {
    const q = parseQuery(baseInput, { allowEmptyFilters: false })
    expect(q.userId).toBe('user_1')
    expect(q.groupBy).toBe('hour')
    expect(q.timeMetric).toBe('agentActive')
    expect(q.timeZone).toBe('UTC')
    expect(q.format).toBe('native')
    expect(q.limit).toBe(50)
    expect(q.skip).toBe(0)
  })

  it('clamps limit to [1, 500]', () => {
    expect(parseQuery({ ...baseInput, limit: -1 }, { allowEmptyFilters: false }).limit).toBe(50)
    expect(parseQuery({ ...baseInput, limit: 9999 }, { allowEmptyFilters: false }).limit).toBe(500)
    expect(parseQuery({ ...baseInput, limit: 100 }, { allowEmptyFilters: false }).limit).toBe(100)
  })

  it('clamps skip to >= 0', () => {
    expect(parseQuery({ ...baseInput, skip: -5 }, { allowEmptyFilters: false }).skip).toBe(0)
    expect(parseQuery({ ...baseInput, skip: 250 }, { allowEmptyFilters: false }).skip).toBe(250)
  })

  it('honours non-default options', () => {
    const q = parseQuery(
      { ...baseInput, groupBy: 'day', timeMetric: 'userActive', timeZone: 'Europe/Madrid', format: 'otel' },
      { allowEmptyFilters: false },
    )
    expect(q.groupBy).toBe('day')
    expect(q.timeMetric).toBe('userActive')
    expect(q.timeZone).toBe('Europe/Madrid')
    expect(q.format).toBe('otel')
  })

  it('coerces NoSQL-operator filters to undefined while keeping string filters (R8.4)', () => {
    const q = parseQuery(
      {
        from: baseInput.from,
        to: baseInput.to,
        // A Mongo operator object instead of a string id — the classic NoSQL
        // injection. Mutation: reverting str() to a bare cast leaks the object
        // straight into $match → red.
        userId: { $ne: null },
        agentId: 'agent_1',
        statuses: ['completed', { $ne: null }],
      },
      { allowEmptyFilters: true },
    )
    expect(q.userId).toBeUndefined()
    expect(q.agentId).toBe('agent_1')
    // Only the string member of statuses survives.
    expect(q.statuses).toEqual(['completed'] as any)
  })

  it('maps collapseGroups only when the flag is exactly true (A4.6)', () => {
    expect(parseQuery({ ...baseInput, collapseGroups: true }, { allowEmptyFilters: true }).collapseGroups).toBe(true)
    expect(parseQuery({ ...baseInput, collapseGroups: 'yes' }, { allowEmptyFilters: true }).collapseGroups).toBe(false)
    expect(parseQuery(baseInput, { allowEmptyFilters: true }).collapseGroups).toBe(false)
  })
})

describe('buildTokensPerHourPipeline — groupKey:none variant (A4.6)', () => {
  const q = (over: Record<string, unknown>) =>
    parseQuery({ ...baseInput, ...over }, { allowEmptyFilters: true })

  function groupId(pipeline: object[]): Record<string, unknown> {
    const group = pipeline.find((s) => '$group' in s) as { $group: { _id: Record<string, unknown> } }
    return group.$group._id
  }

  it('agentActive default carries the per-group dims in the _id', () => {
    const id = groupId(buildTokensPerHourPipeline(q({ timeMetric: 'agentActive' })))
    // Mutation: making this bucket-only unconditionally would drop these keys.
    expect(Object.keys(id).sort()).toEqual(['agentId', 'bucket', 'provider', 'userId', 'workspaceId'])
  })

  it('collapseGroups makes the _id bucket-only (144k rows → per-bucket)', () => {
    const pipeline = buildTokensPerHourPipeline(q({ timeMetric: 'agentActive', collapseGroups: true }))
    expect(Object.keys(groupId(pipeline))).toEqual(['bucket'])
    // The $project echoes an empty groupKey so the shape stays consistent.
    const project = pipeline.find((s) => '$project' in s) as { $project: { groupKey: unknown } }
    expect(project.$project.groupKey).toEqual({})
  })

  it('userActive is already bucket-only regardless of the flag (regression)', () => {
    expect(Object.keys(groupId(buildTokensPerHourPipeline(q({ timeMetric: 'userActive' }))))).toEqual(['bucket'])
  })
})

// ── Live-hour fold for -tokens-per-hour (P1 of the 2026-07-07 monitoring audit) ──

import {
  type TokensBucketRow,
  buildLiveTokensBuckets,
  mergeTokensBucketRows,
  truncateToBucket,
} from '../../src/services/agent-usage-query-helper'

const NOW = new Date('2026-07-07T16:40:00Z')

function makeSession(over: Partial<Parameters<typeof buildLiveTokensBuckets>[0][number]> = {}) {
  return {
    userId: 'user_a',
    agentId: 'agent_a',
    workspaceId: 'work_a',
    provider: 'teros' as any,
    startedAt: new Date('2026-07-07T16:10:00Z'),
    durationMs: 60_000,
    inputTokens: 100,
    outputTokens: 20,
    cachedReadTokens: 10,
    totalTokens: 120,
    costUsd: 0.5,
    ...over,
  }
}

describe('truncateToBucket', () => {
  it('hour keeps the UTC hour, day and week truncate to UTC midnight / Sunday', () => {
    const d = new Date('2026-07-07T16:40:33Z') // Tuesday
    expect(truncateToBucket(d, 'hour').toISOString()).toBe('2026-07-07T16:00:00.000Z')
    expect(truncateToBucket(d, 'day').toISOString()).toBe('2026-07-07T00:00:00.000Z')
    expect(truncateToBucket(d, 'week').toISOString()).toBe('2026-07-05T00:00:00.000Z')
  })
})

describe('buildLiveTokensBuckets', () => {
  it('sums sessions sharing (bucket, groupKey) into ONE exact row', () => {
    const rows = buildLiveTokensBuckets(
      [makeSession(), makeSession({ inputTokens: 50, outputTokens: 5, cachedReadTokens: 0, totalTokens: 55, costUsd: 0.25, durationMs: 30_000 })],
      'hour',
      NOW,
    )
    expect(rows).toEqual([
      {
        bucket: new Date('2026-07-07T16:00:00.000Z'),
        groupKey: { userId: 'user_a', agentId: 'agent_a', provider: 'teros', workspaceId: 'work_a' },
        inputTokens: 150,
        outputTokens: 25,
        cachedReadTokens: 10,
        totalTokens: 175,
        costUsd: 0.75,
        activeMs: 90_000,
        activeHours: 90_000 / 3_600_000,
        sessionCount: 2,
        tokensPerActiveHour: 175 / (90_000 / 3_600_000),
      },
    ])
  })

  it('a still-running session (durationMs null) counts now − startedAt as active time', () => {
    const rows = buildLiveTokensBuckets(
      [makeSession({ durationMs: null, startedAt: new Date('2026-07-07T16:30:00Z') })],
      'hour',
      NOW,
    )
    expect(rows[0]!.activeMs).toBe(10 * 60_000)
  })

  it('different groupKeys stay as separate rows', () => {
    const rows = buildLiveTokensBuckets(
      [makeSession(), makeSession({ agentId: 'agent_b' })],
      'hour',
      NOW,
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.groupKey.agentId).sort()).toEqual(['agent_a', 'agent_b'])
  })
})

describe('mergeTokensBucketRows', () => {
  const rollupRow: TokensBucketRow = {
    bucket: new Date('2026-07-07T00:00:00.000Z'),
    groupKey: { userId: 'user_a', agentId: 'agent_a', provider: 'teros', workspaceId: 'work_a' },
    inputTokens: 1_000,
    outputTokens: 200,
    cachedReadTokens: 0,
    totalTokens: 1_200,
    costUsd: 2,
    activeMs: 3_600_000,
    activeHours: 1,
    sessionCount: 4,
    tokensPerActiveHour: 1_200,
  }

  it('sums a live row into the rollup row sharing (bucket, groupKey) — groupBy day', () => {
    const live = buildLiveTokensBuckets([makeSession()], 'day', NOW)
    const merged = mergeTokensBucketRows([rollupRow], live)
    expect(merged).toEqual([
      {
        bucket: new Date('2026-07-07T00:00:00.000Z'),
        groupKey: { userId: 'user_a', agentId: 'agent_a', provider: 'teros', workspaceId: 'work_a' },
        inputTokens: 1_100,
        outputTokens: 220,
        cachedReadTokens: 10,
        totalTokens: 1_320,
        costUsd: 2.5,
        activeMs: 3_660_000,
        activeHours: 3_660_000 / 3_600_000,
        sessionCount: 5,
        tokensPerActiveHour: 1_320 / (3_660_000 / 3_600_000),
      },
    ])
  })

  it('a live row with a new (bucket, groupKey) is appended in chronological order', () => {
    const live = buildLiveTokensBuckets([makeSession({ agentId: 'agent_b' })], 'hour', NOW)
    const merged = mergeTokensBucketRows([rollupRow], live)
    expect(merged).toHaveLength(2)
    expect(merged[0]!.groupKey.agentId).toBe('agent_a')
    expect(merged[1]!.groupKey.agentId).toBe('agent_b')
    // The rollup row is untouched (no accidental mutation of derived fields).
    expect(merged[0]!.tokensPerActiveHour).toBe(1_200)
  })

  it('returns the rollup rows untouched (same reference) when there is nothing live', () => {
    const input = [rollupRow]
    expect(mergeTokensBucketRows(input, [])).toBe(input)
  })
})

describe('demo-seed exclusion in read pipelines (A1.2/A3.7)', () => {
  const q = parseQuery(baseInput, { allowEmptyFilters: true })

  it('excludes demoSeed docs from the tokens-per-hour $match', () => {
    const pipeline = buildTokensPerHourPipeline(q) as Array<{ $match?: Record<string, unknown> }>
    const match = pipeline.find((s) => s.$match)?.$match
    // Mutation: dropping ...EXCLUDE_DEMO_SEED from the builder → undefined → red.
    expect(match?.demoSeed).toEqual({ $ne: true })
  })

  it('excludes demoSeed docs from the sessions list filter', () => {
    const { filter } = buildSessionsListPipeline(q)
    expect((filter as Record<string, unknown>).demoSeed).toEqual({ $ne: true })
  })

  it('excludes demoSeed docs from the tool-executions list filter', () => {
    const { filter } = buildToolExecutionsListPipeline(q)
    expect((filter as Record<string, unknown>).demoSeed).toEqual({ $ne: true })
  })
})
