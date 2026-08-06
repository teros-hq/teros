/**
 * addMonthsClampDay — UTC month arithmetic with end-of-month clamping (FASE 1d).
 *
 * Replaces the naive `d.setMonth(d.getMonth() + 1)` that overflows month-end
 * anchors (Jan 31 + 1mo → Mar 3). Boundary-focused (CORRECT): month-end, leap
 * year, year rollover, time-of-day preservation, multi-month.
 */

import { describe, expect, it } from 'bun:test'
import { addMonthsClampDay } from '../../src/models/billing'

const iso = (d: Date) => d.toISOString()

describe('addMonthsClampDay', () => {
  it('clamps Jan 31 + 1 month to Feb 28 (non-leap)', () => {
    expect(iso(addMonthsClampDay(new Date('2026-01-31T00:00:00Z'), 1))).toBe('2026-02-28T00:00:00.000Z')
  })

  it('clamps Jan 31 + 1 month to Feb 29 (leap year)', () => {
    expect(iso(addMonthsClampDay(new Date('2024-01-31T00:00:00Z'), 1))).toBe('2024-02-29T00:00:00.000Z')
  })

  it('keeps a normal day unchanged (Mar 15 + 1mo = Apr 15)', () => {
    expect(iso(addMonthsClampDay(new Date('2026-03-15T00:00:00Z'), 1))).toBe('2026-04-15T00:00:00.000Z')
  })

  it('rolls the year over (Dec 10 + 1mo = Jan 10 next year)', () => {
    expect(iso(addMonthsClampDay(new Date('2026-12-10T00:00:00Z'), 1))).toBe('2027-01-10T00:00:00.000Z')
  })

  it('clamps Aug 31 + 1 month to Sep 30 (30-day month)', () => {
    expect(iso(addMonthsClampDay(new Date('2026-08-31T00:00:00Z'), 1))).toBe('2026-09-30T00:00:00.000Z')
  })

  it('preserves the time-of-day', () => {
    expect(iso(addMonthsClampDay(new Date('2026-01-31T13:45:09.250Z'), 1))).toBe('2026-02-28T13:45:09.250Z')
  })

  it('supports multi-month spans (Jan 31 + 13mo = Feb 28 next year)', () => {
    expect(iso(addMonthsClampDay(new Date('2026-01-31T00:00:00Z'), 13))).toBe('2027-02-28T00:00:00.000Z')
  })
})
