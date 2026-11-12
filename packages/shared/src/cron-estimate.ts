/**
 * Rough "how often does this cron fire?" arithmetic, shared by the Automate
 * window form, the Automate agent tools and the backend so all three warn
 * with the same number when a schedule would blow through the subscriber's
 * daily execution quota.
 *
 * Only the minute and hour fields matter for "runs on a day it fires": the
 * day / month / weekday fields decide WHICH days, not how many times per
 * day. The estimate is exact for the common shapes (`*`, lists, ranges,
 * steps) and never claims more precision than that — it is a warning
 * heuristic, not a scheduler.
 */

const FIELD_BOUNDS: Record<'minute' | 'hour', [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
}

/** Number of distinct values a single cron field matches within its bounds; null when unparsable. */
export function countCronFieldValues(field: string, kind: 'minute' | 'hour'): number | null {
  const [min, max] = FIELD_BOUNDS[kind]
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step <= 0) return null
    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number)
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null
      lo = a
      hi = b
    } else {
      const n = Number(rangePart)
      if (!Number.isInteger(n)) return null
      lo = n
      // "n/step" means "from n to max every step"; a bare "n" is just n.
      hi = stepPart === undefined ? n : max
    }
    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return values.size
}

/**
 * Executions per day on a day the schedule is active, for a 5-field cron.
 * Returns null when the expression is not a 5-field cron or a field is not
 * understood (names like MON or JAN are not needed for minute/hour).
 */
export function estimateCronRunsPerDay(cronExpression: string): number | null {
  const fields = cronExpression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const minutes = countCronFieldValues(fields[0], 'minute')
  const hours = countCronFieldValues(fields[1], 'hour')
  if (minutes === null || hours === null) return null
  return minutes * hours
}
