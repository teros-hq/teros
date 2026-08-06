/**
 * Structural invariant (lint-as-test) for Sentry coverage of the billing crons
 * — FASE 10, nota 21.
 *
 * Three cron loops swallow per-item errors to isolate one bad item and keep the
 * batch going (already covered behaviorally by the per-item error-isolation
 * tests). The cost of that isolation: a swallowed error is invisible in prod
 * unless it's also reported. nota 21 adds captureException to each per-item catch.
 *
 * This test pins that reporting to the RIGHT catch by proximity to the catch's
 * known log line — deleting the captureException call (or moving it out of the
 * catch) turns the matching assertion red. Cheap and comprehensive; the per-item
 * error-isolation behavior itself is tested in billing-reset-cron-edges /
 * billing-charge / billing-tracker.
 *
 * PROVEN TO BITE: removing the `captureException(` line under each log message
 * turns the corresponding assertion red (the proximity match fails).
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SVC = join(import.meta.dir, '..', '..', 'src', 'services')

const CASES = [
  {
    file: 'agent-hours-tracker.ts',
    logLine: 'agent-hours-tracker: failed to bill user',
  },
  {
    file: 'billing-reset-cron.ts',
    logLine: 'billing-reset-cron: failed to reset subscription',
  },
  {
    file: 'billing-charge-cron.ts',
    logLine: 'billing-charge-cron: failed to process invoice',
  },
] as const

describe('billing crons — per-item catch reports to Sentry (FASE 10, nota 21)', () => {
  for (const { file, logLine } of CASES) {
    const src = readFileSync(join(SVC, file), 'utf8')

    it(`${file} imports captureException from lib/sentry`, () => {
      expect(src).toMatch(/import\s*\{[^}]*captureException[^}]*\}\s*from\s*['"]\.\.\/lib\/sentry/)
    })

    it(`${file} calls captureException inside the per-item catch`, () => {
      // The log line lives in the per-item catch; require captureException( within
      // a short window AFTER it — i.e. the same catch block reports the swallowed
      // error. (If someone deletes the call, the swallow becomes silent again.)
      const escaped = logLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`${escaped}[\\s\\S]{0,200}captureException\\(`)
      expect(src).toMatch(re)
    })
  }
})
