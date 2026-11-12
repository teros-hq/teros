/**
 * Tests for formatAgentDuration (WS2) — the single formatter behind every
 * agent-hours surface (chat header chip, conversations row, task card badge,
 * task detail row).
 *
 * The exact formats come from Pablo (2026-10-25) and MUST NOT drift:
 *   < 1h → minutes glued: '0m', '30m', '59m'
 *   ≥ 1h → hours ONLY, one decimal, floored: '1.0h', '2.3h', '26.0h'
 * Floor everywhere — never show more than was used.
 */

import { describe, expect, it } from 'bun:test'
import {
  AGENT_DURATION_UNITS,
  formatAgentDuration,
  formatAgentDurationParts,
} from './agent-duration'

const MIN = 60_000
const HOUR = 3_600_000

describe('formatAgentDuration', () => {
  it('0 ms → "0m" (starts at zero, never seconds)', () => {
    expect(formatAgentDuration(0)).toBe('0m')
  })

  it('30 min → "30m"', () => {
    expect(formatAgentDuration(30 * MIN)).toBe('30m')
  })

  it('59 m 59 s → "59m" (floor, conservative)', () => {
    expect(formatAgentDuration(59 * MIN + 59_000)).toBe('59m')
  })

  it('exactly 60 min → "1.0h" (the switch to hours-only)', () => {
    expect(formatAgentDuration(60 * MIN)).toBe('1.0h')
  })

  it('1 h 1 m → "1.0h" (1.016h floored, not rounded up)', () => {
    expect(formatAgentDuration(HOUR + MIN)).toBe('1.0h')
  })

  it('2 h 20 m → "2.3h" (2.333h floored to one decimal)', () => {
    expect(formatAgentDuration(2 * HOUR + 20 * MIN)).toBe('2.3h')
  })

  it('exactly 2 h → "2.0h"', () => {
    expect(formatAgentDuration(2 * HOUR)).toBe('2.0h')
  })

  it('5 h 24 m → "5.4h" (5.4h on the nose)', () => {
    expect(formatAgentDuration(5 * HOUR + 24 * MIN)).toBe('5.4h')
  })

  it('huge durations keep the same shape (no minutes tail, no days/weeks)', () => {
    expect(formatAgentDuration(26 * HOUR + 5 * MIN)).toBe('26.0h')
  })

  it('negative and non-finite input clamp to "0m"', () => {
    expect(formatAgentDuration(-5 * MIN)).toBe('0m')
    expect(formatAgentDuration(Number.NaN)).toBe('0m')
    expect(formatAgentDuration(Number.POSITIVE_INFINITY)).toBe('0m')
  })

  it('sub-minute work still shows "0m" (never seconds)', () => {
    expect(formatAgentDuration(45_000)).toBe('0m')
    expect(formatAgentDuration(1)).toBe('0m')
  })
})

describe('formatAgentDurationParts (raw pieces for i18n consumers)', () => {
  it('sub-hour → unit "m", hours 0', () => {
    expect(formatAgentDurationParts(30 * MIN)).toEqual({ hours: 0, minutes: 30, unit: 'm' })
  })

  it('≥1h → unit "h" with hour+minute split', () => {
    expect(formatAgentDurationParts(2 * HOUR + 20 * MIN)).toEqual({
      hours: 2,
      minutes: 20,
      unit: 'h',
    })
  })

  it('floor keeps minutes honest (59m59s → 59)', () => {
    expect(formatAgentDurationParts(59 * MIN + 59_000).minutes).toBe(59)
  })

  it('unit labels are overridable for translation', () => {
    expect(AGENT_DURATION_UNITS.h).toBe('h')
    expect(AGENT_DURATION_UNITS.m).toBe('m')
  })
})
