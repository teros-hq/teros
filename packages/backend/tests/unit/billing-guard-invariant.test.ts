/**
 * Invariant — the phantom-session billing guard cannot be bypassed (TER-650).
 *
 * The phantom-session incident was a hung turn the reconciler closed with full
 * wall-clock duration, which the rollup then billed as work that never happened.
 * `isNonBillableSession` is the guard that drops those sessions before they
 * reach the billed `userActiveMs` aggregate. It has a single call site today —
 * a function guarding one path. This test makes that structural instead of
 * "remember to call it":
 *
 *   A. `userActiveMs` (the field that becomes billed agent-hours) is
 *      MATERIALIZED into a persisted rollup in exactly ONE source file. A second
 *      path that computes it would bypass the guard → this test lists the extra
 *      file and fails.
 *   B. That one file filters sessions through `isNonBillableSession` before
 *      aggregating. Delete the guard and this fails.
 *
 * Together: no code can bill a phantom session without first tripping this test.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'

const SRC = resolve(__dirname, '../../src')
const ROLLUP_JOB = 'services/agent-usage-rollup-job.ts'

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
}

describe('billing guard invariant — isNonBillableSession (TER-650)', () => {
  it('materializes userActiveMs (billed field) into a rollup in exactly one file', () => {
    // A write-materialization is an object-literal key `userActiveMs:` whose
    // value is a runtime expression — NOT the type declaration `userActiveMs:
    // number`. Any file that builds a persisted userActiveMs must be the rollup
    // job (which applies the guard); a second one would bill unguarded.
    const materializers = sourceFiles().filter((rel) => {
      const src = readFileSync(resolve(SRC, rel), 'utf8')
      // `userActiveMs:` then a runtime value — the first non-space char must NOT
      // begin the type `number` (that excludes the `userActiveMs: number` field
      // declaration, matching only real object-literal writes). The trailing \S
      // pins the lookahead so `\s*` can't backtrack to zero and match the space.
      return /userActiveMs:\s*(?!number\b)\S/.test(src)
    })
    expect(materializers).toEqual([ROLLUP_JOB])
  })

  it('the rollup job filters sessions through the guard before aggregating', () => {
    const src = readFileSync(resolve(SRC, ROLLUP_JOB), 'utf8')
    // The guard is defined+exported here…
    expect(/export function isNonBillableSession\(/.test(src)).toBe(true)
    // …and actually used as a skip filter in the aggregation loop. Removing the
    // `if (isNonBillableSession(...)) continue` line turns this red.
    expect(/if\s*\(isNonBillableSession\(/.test(src)).toBe(true)
  })

  it('no other source file calls isNonBillableSession (single guard site)', () => {
    // Not a correctness requirement per se, but pins the surface: if the guard
    // grows a second caller, that path must be reviewed for the same bypass risk.
    const callers = sourceFiles().filter((rel) => {
      const src = readFileSync(resolve(SRC, rel), 'utf8')
      return /isNonBillableSession\(/.test(src)
    })
    expect(callers).toEqual([ROLLUP_JOB])
  })

  it('the rollup job skips sessions with no execution anchor (billable ⟹ ran) (TER-650/G1)', () => {
    // A session only gets a `startedAt` when `session.running` fires (turn start).
    // The rollup MUST skip a null `startedAt` so a still-queued or never-run
    // session (its worker died) can never bill. Removing the
    // `if (!session.startedAt) continue` guard turns this red — the structural
    // form of the invariant "every billable session passed through
    // session.running".
    const src = readFileSync(resolve(SRC, ROLLUP_JOB), 'utf8')
    expect(/if\s*\(!session\.startedAt\)\s*continue/.test(src)).toBe(true)
  })
})
