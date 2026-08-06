import { describe, expect, it } from 'bun:test'
import {
  computeLagHours,
  enumerateHourBuckets,
  isNonBillableSession,
  truncateToHourUTC,
  unionOfIntervalsMs,
} from '../../src/services/agent-usage-rollup-job'

describe('truncateToHourUTC', () => {
  it('truncates minutes/seconds/millis to 0 in UTC', () => {
    const d = new Date('2026-05-19T10:42:37.123Z')
    const t = truncateToHourUTC(d)
    expect(t.toISOString()).toBe('2026-05-19T10:00:00.000Z')
  })

  it('does not mutate the input', () => {
    const d = new Date('2026-05-19T10:42:37.123Z')
    const t = truncateToHourUTC(d)
    expect(d.toISOString()).toBe('2026-05-19T10:42:37.123Z')
    expect(t).not.toBe(d)
  })
})

describe('enumerateHourBuckets', () => {
  it('returns one bucket per hour in the half-open interval', () => {
    const buckets = enumerateHourBuckets(
      new Date('2026-05-19T08:30:00Z'),
      new Date('2026-05-19T11:00:00Z'),
    )
    expect(buckets.map((b) => b.toISOString())).toEqual([
      '2026-05-19T08:00:00.000Z',
      '2026-05-19T09:00:00.000Z',
      '2026-05-19T10:00:00.000Z',
    ])
  })

  it('returns empty when start >= end', () => {
    const a = new Date('2026-05-19T10:00:00Z')
    const b = new Date('2026-05-19T09:00:00Z')
    expect(enumerateHourBuckets(a, b)).toEqual([])
  })
})

describe('unionOfIntervalsMs', () => {
  it('returns 0 for empty input', () => {
    expect(unionOfIntervalsMs([])).toBe(0)
  })

  it('returns the length of a single interval', () => {
    expect(unionOfIntervalsMs([{ start: 0, end: 1000 }])).toBe(1000)
  })

  it('coalesces overlapping intervals', () => {
    const total = unionOfIntervalsMs([
      { start: 0, end: 500 },
      { start: 400, end: 1000 },
    ])
    expect(total).toBe(1000)
  })

  it('keeps disjoint intervals separate', () => {
    const total = unionOfIntervalsMs([
      { start: 0, end: 500 },
      { start: 600, end: 1000 },
    ])
    expect(total).toBe(900)
  })

  it('handles unordered input', () => {
    const total = unionOfIntervalsMs([
      { start: 600, end: 1000 },
      { start: 0, end: 500 },
    ])
    expect(total).toBe(900)
  })

  it('handles fully contained intervals', () => {
    const total = unionOfIntervalsMs([
      { start: 0, end: 1000 },
      { start: 200, end: 300 },
    ])
    expect(total).toBe(1000)
  })

  it('user activity within a single hour cannot exceed 3_600_000 ms', () => {
    // Simulate 5 parallel sessions, each 30 minutes, fully overlapping.
    const intervals = Array.from({ length: 5 }, () => ({
      start: 0,
      end: 30 * 60 * 1000,
    }))
    expect(unionOfIntervalsMs(intervals)).toBeLessThanOrEqual(3_600_000)
  })
})

describe('isNonBillableSession', () => {
  // Case that bites the `reconciled_timeout` branch SPECIFICALLY: a status +
  // token count the second branch would NOT catch (tokens > 0). If the first
  // condition is removed, this flips to false → red.
  it('excludes reconciler zombies even with tokens > 0', () => {
    expect(
      isNonBillableSession({
        status: 'timed_out',
        errorKind: 'reconciled_timeout',
        totalTokens: 4321,
      }),
    ).toBe(true)
  })

  it('excludes the canonical phantom session (timed_out, reconciled, 0 tokens)', () => {
    expect(
      isNonBillableSession({
        status: 'timed_out',
        errorKind: 'reconciled_timeout',
        totalTokens: 0,
      }),
    ).toBe(true)
  })

  // Cases that bite the zero-work branch: remove it and these flip to false.
  it('excludes failed sessions that produced zero tokens', () => {
    for (const status of ['errored', 'timed_out', 'aborted'] as const) {
      expect(
        isNonBillableSession({ status, errorKind: 'llm_error', totalTokens: 0 }),
      ).toBe(true)
    }
  })

  // Cases that MUST still bill — guard against over-exclusion.
  it('bills a failed session that did real work (tokens > 0)', () => {
    expect(
      isNonBillableSession({ status: 'errored', errorKind: 'llm_error', totalTokens: 15 }),
    ).toBe(false)
  })

  it('bills a completed session even with 0 tokens (ran to a clean end)', () => {
    expect(
      isNonBillableSession({ status: 'completed', totalTokens: 0 }),
    ).toBe(false)
  })

  it('bills a normal completed session', () => {
    expect(
      isNonBillableSession({ status: 'completed', totalTokens: 9000 }),
    ).toBe(false)
  })
})

describe('computeLagHours', () => {
  it('returns +Inf when no rollups exist yet', () => {
    // Honest "no data" sentinel; the Sentry alarm bridge ignores Inf so
    // a fresh install does not page (no false positives on cold boot).
    expect(computeLagHours(new Date(), null)).toBe(Number.POSITIVE_INFINITY)
  })

  it('returns 0 when the latest rollup is the current closed hour', () => {
    const now = truncateToHourUTC(new Date('2026-05-20T11:30:00Z'))
    const latest = new Date(now.getTime() - 3_600_000) // previous closed hour
    expect(computeLagHours(now, latest)).toBe(0)
  })

  it('returns the gap in hours when rollups are stale', () => {
    const now = truncateToHourUTC(new Date('2026-05-20T11:00:00Z'))
    const latest = new Date(now.getTime() - 5 * 3_600_000)
    expect(computeLagHours(now, latest)).toBe(4)
  })

  it('never returns a negative value', () => {
    const now = truncateToHourUTC(new Date('2026-05-20T11:00:00Z'))
    // latest in the future (shouldn't happen in practice; guard anyway)
    const latest = new Date(now.getTime() + 3_600_000)
    expect(computeLagHours(now, latest)).toBe(0)
  })
})
