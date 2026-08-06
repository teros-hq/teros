/**
 * quota.ts — calendar-month burn projection (pure). Asserts the EXACT snapshot
 * so a mutation (e.g. dropping the real per-user limit) fails. `now` is fixed.
 */

import { describe, expect, it } from 'vitest'
import type { AgentUsageBucket } from '../../../services/AdminApi'
import { DEFAULT_AGENT_HOURS_QUOTA, quotaSnapshot, type QuotaDirectory } from '../quota'

const NOW = new Date('2026-07-15T12:00:00.000Z') // day 15 of a 31-day month

function bucket(userId: string, isoDay: string, activeHours: number): AgentUsageBucket {
  return { bucket: isoDay, groupKey: { userId }, activeHours } as unknown as AgentUsageBucket
}

const DIRECTORY: QuotaDirectory = {
  userIdToName: new Map([
    ['u1', 'Alice'],
    ['u2', 'Bob'],
  ]),
  // u1 has a real 40h plan; u2 has none (0 → falls back to the display default).
  userIdToLimit: new Map([
    ['u1', 40],
    ['u2', 0],
  ]),
}

describe('quotaSnapshot', () => {
  const buckets: AgentUsageBucket[] = [
    bucket('u1', '2026-07-02T09:00:00.000Z', 10), // dayIdx 1
    bucket('u1', '2026-07-10T09:00:00.000Z', 5), // dayIdx 9
    bucket('u2', '2026-07-05T09:00:00.000Z', 20), // dayIdx 4
  ]

  it('computes the calendar-month window', () => {
    const s = quotaSnapshot(buckets, DIRECTORY, NOW)
    expect(s.daysInPeriod).toBe(31)
    expect(s.daysIntoPeriod).toBe(15)
    expect(s.daysLeft).toBe(16)
    expect(s.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('projects per-user against the REAL limit, default only when limit is 0', () => {
    const s = quotaSnapshot(buckets, DIRECTORY, NOW)
    expect(s.userSnapshots.map((u) => u.userId)).toEqual(['u1', 'u2']) // sorted by pct desc
    const u1 = s.userSnapshots[0]
    expect(u1).toMatchObject({ userName: 'Alice', consumedHours: 15, quotaHours: 40 })
    expect(u1.pctConsumed).toBe(37.5) // 15/40
    expect(u1.projectedHours).toBeCloseTo(31, 6) // avgDaily 1 × 31 days
    const u2 = s.userSnapshots[1]
    expect(u2.quotaHours).toBe(DEFAULT_AGENT_HOURS_QUOTA) // limit 0 → fallback 100
    expect(u2.pctConsumed).toBe(20) // 20/100
  })

  it('aggregates totals and the global per-day burn array', () => {
    const s = quotaSnapshot(buckets, DIRECTORY, NOW)
    expect(s.totalConsumed).toBe(35)
    expect(s.totalQuota).toBe(140) // 40 + 100 (sum of REAL quotas, not 100×count)
    expect(s.totalProjected).toBeCloseTo((35 / 15) * 31, 6)
    expect(s.perDayGlobal).toHaveLength(31)
    expect(s.perDayGlobal[1]).toBe(10)
    expect(s.perDayGlobal[4]).toBe(20)
    expect(s.perDayGlobal[9]).toBe(5)
    expect(s.perDayGlobal.reduce((a, b) => a + b, 0)).toBe(35)
  })

  it('ignores buckets outside the current month', () => {
    const s = quotaSnapshot(
      [...buckets, bucket('u1', '2026-06-30T09:00:00.000Z', 99)],
      DIRECTORY,
      NOW,
    )
    expect(s.totalConsumed).toBe(35) // the June bucket is dropped
  })
})
