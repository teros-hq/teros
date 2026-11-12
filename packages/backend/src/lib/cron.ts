/**
 * Cron and timezone helpers shared by Automate (validation + runner).
 *
 * The product contract is 5-field cron (minute hour day month weekday):
 * croner also accepts a 6-field form with seconds and nicknames (@daily…),
 * both rejected here so the minimum interval stays one minute.
 */

import { Cron } from 'croner'

export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}

const VALID_TIMEZONES = new Set<string>(
  typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === 'function'
    ? (Intl as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone')
    : [],
)

export function isValidIanaTimezone(tz: string): boolean {
  if (VALID_TIMEZONES.size > 0) return VALID_TIMEZONES.has(tz)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function assertValidTimezone(tz: string, field = 'timezone'): void {
  if (!isValidIanaTimezone(tz)) {
    throw new CronError(`Invalid IANA timezone "${tz}" for field "${field}". Examples: "Europe/Madrid", "America/New_York", "UTC".`)
  }
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return false
  try {
    const job = new Cron(expression, { paused: true })
    job.stop()
    return true
  } catch {
    return false
  }
}

export function assertValidCron(expression: string): void {
  if (!isValidCronExpression(expression)) {
    throw new CronError(
      `Invalid cron expression: "${expression}". Use exactly 5 fields "minute hour day month weekday" (seconds not supported). Examples: "0 9 * * *", "*/15 * * * *", "0 10-22 * * 1-5".`,
    )
  }
}

/** Next fire time (epoch ms) of a 5-field cron in a timezone. */
export function getNextCronRun(expression: string, timezone: string): number {
  assertValidCron(expression)
  assertValidTimezone(timezone)
  try {
    const job = new Cron(expression, { timezone, paused: true })
    const next = job.nextRun()
    job.stop()
    if (!next) throw new CronError(`Cron "${expression}" produces no future run.`)
    return next.getTime()
  } catch (error) {
    if (error instanceof CronError) throw error
    throw new CronError(`Failed to compute next run for "${expression}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function previewCronOccurrences(expression: string, timezone: string, count = 5): number[] {
  assertValidCron(expression)
  assertValidTimezone(timezone)
  const job = new Cron(expression, { timezone, paused: true })
  const out: number[] = []
  let cursor = new Date()
  for (let i = 0; i < count; i++) {
    const next = job.nextRun(cursor)
    if (!next) break
    out.push(next.getTime())
    cursor = new Date(next.getTime() + 1)
  }
  job.stop()
  return out
}
