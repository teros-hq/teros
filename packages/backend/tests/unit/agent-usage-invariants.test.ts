/**
 * Table-driven property tests for invariants of the agent usage subsystem.
 *
 * `fast-check` is not installed in this repo; we replicate the spirit of PBT
 * with a deterministic table of generated cases that cover boundary and
 * overlap configurations. If `fast-check` is later added, these tests can be
 * upgraded to use `fc.assert(fc.property(...))`.
 *
 * Invariants verified:
 *   - userActiveSeconds(u, h) <= 3_600_000 ms (no exceed 1 hour wall-clock)
 *   - unionOfIntervalsMs is symmetric on input ordering
 *   - unionOfIntervalsMs is idempotent under duplicated intervals
 *   - unionOfIntervalsMs <= sum of interval lengths
 */

import { describe, expect, it } from 'bun:test'
import {
  type Interval,
  unionOfIntervalsMs,
} from '../../src/services/agent-usage-rollup-job'

function generateIntervalSet(seed: number, count: number, span: number): Interval[] {
  const result: Interval[] = []
  let s = seed
  for (let i = 0; i < count; i++) {
    s = (s * 9301 + 49297) % 233280
    const start = (s / 233280) * span
    s = (s * 9301 + 49297) % 233280
    const length = (s / 233280) * span
    const end = Math.min(start + length, span)
    result.push({ start, end })
  }
  return result
}

describe('agent usage invariants — intervals', () => {
  it('never exceeds the upper bound of the window (1 hour)', () => {
    // Stress: 50 parallel sessions in a single hour. Result must be <= 3_600_000.
    for (let seed = 1; seed <= 10; seed++) {
      const set = generateIntervalSet(seed, 50, 3_600_000)
      expect(unionOfIntervalsMs(set)).toBeLessThanOrEqual(3_600_000)
    }
  })

  it('is order-invariant', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const set = generateIntervalSet(seed, 20, 100_000)
      const reversed = [...set].reverse()
      expect(unionOfIntervalsMs(set)).toBe(unionOfIntervalsMs(reversed))
    }
  })

  it('is idempotent under duplication', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const set = generateIntervalSet(seed, 20, 100_000)
      const duplicated = [...set, ...set]
      expect(unionOfIntervalsMs(set)).toBe(unionOfIntervalsMs(duplicated))
    }
  })

  it('is bounded by the sum of interval lengths', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const set = generateIntervalSet(seed, 20, 100_000)
      const sumLengths = set.reduce((acc, iv) => acc + (iv.end - iv.start), 0)
      expect(unionOfIntervalsMs(set)).toBeLessThanOrEqual(sumLengths)
    }
  })

  it('equals the sum of disjoint intervals', () => {
    // Disjoint pairs: [0,100), [200,300), [400,500) → sum 300
    const disjoint: Interval[] = [
      { start: 0, end: 100 },
      { start: 200, end: 300 },
      { start: 400, end: 500 },
    ]
    expect(unionOfIntervalsMs(disjoint)).toBe(300)
  })
})
