/**
 * Shared helpers for the scheduler domain.
 *
 * Mirrors `mcas/mca.teros.scheduler/src/lib/{time,cron,format,timezone,errors}.ts`
 * so that both the WsRouter path and the MCA path emit identical shapes
 * (criterio 22 de MCA-RUNBOOK.md). Keep these in sync — if you fix one,
 * fix the other.
 */

import * as chrono from 'chrono-node'
import { Cron } from 'croner'

// ===========================================================================
// Errors
// ===========================================================================

export type SchedulerErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TIMEZONE'
  | 'INVALID_CRON'
  | 'INVALID_TIME_EXPRESSION'
  | 'AMBIGUOUS_TIME_EXPRESSION'
  | 'PAST_TIME_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'ALREADY_TERMINAL'
  | 'FORBIDDEN'
  | 'NO_USER_CONTEXT'

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode
  readonly suggestion?: string
  constructor(code: SchedulerErrorCode, message: string, suggestion?: string) {
    super(message)
    this.name = 'SchedulerError'
    this.code = code
    this.suggestion = suggestion
  }
}

// ===========================================================================
// Timezone
// ===========================================================================

const VALID_TIMEZONES = new Set<string>(
  typeof (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf === 'function'
    ? (Intl as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone')
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

export function resolveDefaultTimezone(): string {
  const env = process.env.MCA_DEFAULT_TIMEZONE?.trim()
  if (env && isValidIanaTimezone(env)) return env
  return 'Europe/Madrid'
}

export function assertValidTimezone(tz: string, field = 'timezone'): void {
  if (!isValidIanaTimezone(tz)) {
    throw new SchedulerError(
      'INVALID_TIMEZONE',
      `Invalid IANA timezone "${tz}" for field "${field}".`,
      'Examples: "Europe/Madrid", "America/New_York", "UTC", "Asia/Tokyo".',
    )
  }
}

// ===========================================================================
// Channel ownership — espejo de `mcas/mca.teros.scheduler/src/tools/_shared.ts`
// (criterio 22). El MCA valida shape + ownership ANTES del write; este path
// debe imponer el mismo contrato o un reminder hacia un canal ajeno se acepta
// aquí y falla silenciosamente días después en dispatch (Capa 3 del executor).
// ===========================================================================

/**
 * Shape canónico de los channelIds en Teros: `ch_<16 hex chars>` según
 * `core/src/ids.ts`. Mismo regex que el MCA.
 */
export const CHANNEL_ID_REGEX = /^ch_[0-9a-f]{16}$/

export function assertValidChannelId(channelId: string): void {
  if (!CHANNEL_ID_REGEX.test(channelId)) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `channelId must match ${CHANNEL_ID_REGEX} (got: "${channelId.slice(0, 64)}").`,
      'Use the channelId emitted by channel.create or returned by an event payload.',
    )
  }
}

export type GetChannelOwner = (channelId: string) => Promise<string | null>

/**
 * Write-time ownership gate. Owner ESTRICTO (`channel.userId`) — misma
 * semántica que las Capas 2/3/4 (bootstrap `getChannelOwnerUserIdFn`) y que el
 * MCA. NO usa workspace-membership a propósito: el dispatch (Capa 3) exige
 * owner estricto, así que aceptar aquí un canal de workspace compartido solo
 * pospondría el fallo. Canal inexistente → owner null → FORBIDDEN (igual que
 * el MCA: `!channel || channel.userId !== userId`).
 */
export async function assertChannelOwnership(
  getChannelOwner: GetChannelOwner,
  userId: string,
  channelId: string,
): Promise<void> {
  const owner = await getChannelOwner(channelId)
  if (owner !== userId) {
    throw new SchedulerError(
      'FORBIDDEN',
      `Channel ${channelId} does not belong to user.`,
      'Use a channel you own — channel.list returns yours.',
    )
  }
}

// ===========================================================================
// Cron
// ===========================================================================

export function isValidCronExpression(expression: string): boolean {
  // El scheduler tickea cada 30s y el contrato del producto es cron de 5
  // campos (minuto hora día mes díaSemana). croner ADEMÁS acepta la forma de
  // 6 campos con SEGUNDOS (p.ej. "*/30 * * * * *" → cada 30s) y nicknames
  // (@daily…); ambos sub-minuto/no-canónicos hacen que el tick dispare la
  // tarea en CADA tick (~30s) con horas irregulares. Rechazamos != 5 campos
  // para acotar el intervalo mínimo a 1 minuto. Como el executor llama a
  // `getNextCronRun` → `assertValidCron`, una task 6-field ya existente se
  // auto-deshabilita (fail-loud) en el siguiente tick.
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
    throw new SchedulerError(
      'INVALID_CRON',
      `Invalid cron expression: "${expression}".`,
      'Use exactly 5 fields "minute hour day month weekday" (seconds not supported).',
    )
  }
}

export function getNextCronRun(expression: string, timezone: string): number {
  assertValidCron(expression)
  assertValidTimezone(timezone)
  const job = new Cron(expression, { timezone, paused: true })
  const next = job.nextRun()
  job.stop()
  if (!next) throw new SchedulerError('INVALID_CRON', `Cron "${expression}" has no future run.`)
  return next.getTime()
}

export function previewCronOccurrences(
  expression: string,
  timezone: string,
  count = 5,
): number[] {
  assertValidCron(expression)
  assertValidTimezone(timezone)
  const job = new Cron(expression, { timezone, paused: true })
  const out: number[] = []
  let cursor: Date | undefined = new Date()
  for (let i = 0; i < count; i++) {
    const next: Date | null = job.nextRun(cursor)
    if (!next) break
    out.push(next.getTime())
    cursor = new Date(next.getTime() + 1)
  }
  job.stop()
  return out
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const COMMON_PATTERNS: Record<string, string> = {
  '0 9 * * *': 'Every day at 9:00',
  '0 9 * * 1-5': 'Every weekday at 9:00',
  '0 */2 * * *': 'Every 2 hours',
  '*/15 * * * *': 'Every 15 minutes',
  '0 10-22 * * 1-5': 'Every hour from 10:00 to 22:00 on weekdays',
  '0 0 * * *': 'Every day at midnight',
  '0 12 * * *': 'Every day at noon',
  '0 0 * * 0': 'Every Sunday at midnight',
  '0 0 1 * *': 'First day of every month at midnight',
}

export function describeCronExpression(expression: string): string {
  const trimmed = expression.trim()
  if (COMMON_PATTERNS[trimmed]) return COMMON_PATTERNS[trimmed]
  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return trimmed
  const [minute, hour, , , dayOfWeek] = parts
  let description = ''
  if (minute === '*') description = 'Every minute'
  else if (minute.startsWith('*/')) description = `Every ${minute.slice(2)} minutes`
  else description = `At minute ${minute}`
  if (hour !== '*') {
    if (hour.includes('-')) description += ` between hours ${hour}`
    else if (hour.startsWith('*/')) description += ` every ${hour.slice(2)} hours`
    else description += ` at hour ${hour}`
  }
  if (dayOfWeek !== '*') {
    if (dayOfWeek === '1-5') description += ' on weekdays'
    else if (dayOfWeek.includes(',')) {
      const days = dayOfWeek.split(',').map((d) => DAY_NAMES[parseInt(d, 10)] ?? d)
      description += ` on ${days.join(', ')}`
    } else if (dayOfWeek.includes('-')) description += ` on days ${dayOfWeek}`
    else description += ` on ${DAY_NAMES[parseInt(dayOfWeek, 10)] ?? dayOfWeek}`
  }
  return description
}

// ===========================================================================
// Time parser (chrono-node)
// ===========================================================================

export type ParseLocale = 'en' | 'es'

export interface ParseTimeOptions {
  reference?: Date
  timezone: string
  locale?: ParseLocale
  allowPast?: boolean
}

export interface ParsedTime {
  date: Date
  timestamp: number
  confidence: 'high' | 'medium'
  locale: ParseLocale
  detectedText: string
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/

interface ChronoNs {
  parse: (
    text: string,
    ref?: { instant: Date; timezone?: string } | Date,
    opts?: { forwardDate?: boolean },
  ) => Array<{ text: string; date(): Date; start: { isCertain(field: string): boolean } }>
}

function pickParser(locale?: ParseLocale): { parser: ChronoNs; locale: ParseLocale } {
  if (locale === 'es' && chrono.es) return { parser: chrono.es as unknown as ChronoNs, locale: 'es' }
  return { parser: chrono.en as unknown as ChronoNs, locale: 'en' }
}

// TZ-aware reinterpretation of literal hour tokens (P1-1 fix).
// See `mcas/mca.teros.scheduler/src/lib/time.ts` for the rationale.
function tzOffsetAt(at: Date, tz: string): number {
  const pad = (parts: Intl.DateTimeFormatPart[]): number => {
    const o = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
    const hour = Number(o.hour) === 24 ? 0 : Number(o.hour)
    return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), hour, Number(o.minute), Number(o.second))
  }
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  return pad(tzParts) - pad(utcParts)
}

function reinterpretLiteralHourInTimezone(parsed: Date, targetTz: string): Date {
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (serverTz === targetTz) return parsed
  const serverOffset = tzOffsetAt(parsed, serverTz)
  const targetOffset = tzOffsetAt(parsed, targetTz)
  return new Date(parsed.getTime() + serverOffset - targetOffset)
}

export function parseTimeExpression(input: string, opts: ParseTimeOptions): ParsedTime {
  if (!input || !input.trim()) throw new SchedulerError('INVALID_INPUT', 'Time expression is empty.')
  const reference = opts.reference ?? new Date()
  const trimmed = input.trim()

  if (ISO_LIKE.test(trimmed)) {
    const parsed = new Date(trimmed)
    if (Number.isNaN(parsed.getTime())) {
      throw new SchedulerError('INVALID_TIME_EXPRESSION', `Could not parse ISO time "${input}".`)
    }
    if (!opts.allowPast && parsed.getTime() < reference.getTime()) {
      throw new SchedulerError('PAST_TIME_NOT_ALLOWED', `Time "${input}" is in the past.`)
    }
    return {
      date: parsed,
      timestamp: parsed.getTime(),
      confidence: 'high',
      locale: opts.locale ?? 'en',
      detectedText: trimmed,
    }
  }

  const { parser, locale } = pickParser(opts.locale)
  const results = parser.parse(input, { instant: reference, timezone: opts.timezone }, { forwardDate: true })
  if (results.length === 0) {
    throw new SchedulerError(
      'INVALID_TIME_EXPRESSION',
      `Could not parse "${input}" (locale=${locale}).`,
      'Try: "in 2 hours", "tomorrow at 9am", or ISO 8601.',
    )
  }
  if (results.length > 1) {
    throw new SchedulerError('AMBIGUOUS_TIME_EXPRESSION', `"${input}" matched ${results.length} times.`)
  }
  const r = results[0]
  const certainHour = r.start.isCertain('hour')
  const certainDay = r.start.isCertain('day')
  let date = r.date()
  // P1-1 fix: reinterpret literal hour in target TZ when the user wrote one
  // explicitly. Heuristic over text — `isCertain('hour')` is unreliable.
  const LITERAL_HOUR_RE = /(\d{1,2}\s?(?:am|pm)|\d{1,2}[:h]\d{2}|\bnoon\b|\bmidnight\b|\bmediod[ií]a\b|\bmedianoche\b)/i
  if (LITERAL_HOUR_RE.test(r.text)) {
    date = reinterpretLiteralHourInTimezone(date, opts.timezone)
  }
  if (!opts.allowPast && date.getTime() < reference.getTime()) {
    throw new SchedulerError('PAST_TIME_NOT_ALLOWED', `Parsed time is in the past.`)
  }
  return {
    date,
    timestamp: date.getTime(),
    confidence: certainHour && certainDay ? 'high' : 'medium',
    locale,
    detectedText: r.text,
  }
}

export function parseDelayExpression(input: string): number {
  const m = input.trim().match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i)
  if (!m) throw new SchedulerError('INVALID_INPUT', `Could not parse delay "${input}".`, 'Use "30m", "2h", "1d".')
  const value = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  if (unit.startsWith('s')) return value * 1000
  if (unit.startsWith('mi') || unit === 'm') return value * 60_000
  if (unit.startsWith('h')) return value * 3_600_000
  if (unit.startsWith('d')) return value * 86_400_000
  return 0
}

export function formatNextRun(timestamp: number, timezone: string, now = Date.now()): string {
  const diffMs = timestamp - now
  const absMs = Math.abs(diffMs)
  const past = diffMs < 0
  const min = Math.round(absMs / 60_000)
  if (absMs < 60_000) return past ? 'just now' : 'in <1 minute'
  if (min < 60) return past ? `${min} minute${min === 1 ? '' : 's'} ago` : `in ${min} minute${min === 1 ? '' : 's'}`
  const hours = Math.round(min / 60)
  if (hours < 24) return past ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  if (days < 7) {
    if (past) return `${days} day${days === 1 ? '' : 's'} ago`
    if (days === 1) {
      const t = new Date(timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: timezone,
      })
      return `tomorrow at ${t}`
    }
    return `in ${days} days`
  }
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  })
}

// ===========================================================================
// Format (formatted output shape — IDENTICAL to MCA's lib/format.ts)
// ===========================================================================

// Row types canónicos viven en `@teros/shared/scheduler` (TER-358). Re-export
// con alias `*Row` para no romper imports históricos.
import type { Reminder, RecurringTask, Execution } from '@teros/shared'
export type ReminderRow = Reminder
export type RecurringTaskRow = RecurringTask
export type ExecutionRow = Execution

export interface FormattedReminder {
  id: number
  message: string
  channelId: string
  status: 'pending' | 'dispatching' | 'sent' | 'cancelled' | 'failed'
  nextRunAt: number
  nextRunIso: string
  humanReadable: string
  timezone: string
  createdAt: string
}

export interface FormattedRecurringTask {
  id: number
  message: string
  channelId: string
  cronExpression: string
  cronDescription: string
  enabled: boolean
  timezone: string
  nextRunAt: number
  nextRunIso: string
  humanReadable: string
  lastRunAt?: number
  lastRunIso?: string
  createdAt: string
}

export interface FormattedExecution {
  taskId: number
  ranAt: number
  ranAtIso: string
  status: 'success' | 'failure' | 'skipped'
  error?: string
}

/**
 * Mirror of MCA `lib/format.ts:formatReminder`. The TZ used is — in priority
 * order — the one stored in the document (persisted at create time), or the
 * fallback passed by the caller. P2-1 fix (TER-186 audit 2026-05-06).
 */
export function formatReminder(r: ReminderRow, fallbackTimezone: string): FormattedReminder {
  const nextRunAt = r.scheduled_time
  const timezone = r.timezone ?? fallbackTimezone
  return {
    id: r.id ?? 0,
    message: r.message,
    channelId: r.channel_id,
    status: r.status,
    nextRunAt,
    nextRunIso: new Date(nextRunAt).toISOString(),
    humanReadable: formatNextRun(nextRunAt, timezone),
    timezone,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export function formatRecurringTask(t: RecurringTaskRow): FormattedRecurringTask {
  const enabled = t.enabled === true || (t.enabled as unknown as number) === 1
  return {
    id: t.id ?? 0,
    message: t.message,
    channelId: t.channel_id,
    cronExpression: t.cron_expression,
    cronDescription: describeCronExpression(t.cron_expression),
    enabled,
    timezone: t.timezone,
    nextRunAt: t.next_run,
    nextRunIso: new Date(t.next_run).toISOString(),
    humanReadable: formatNextRun(t.next_run, t.timezone),
    lastRunAt: t.last_run,
    lastRunIso: t.last_run ? new Date(t.last_run).toISOString() : undefined,
    createdAt: new Date(t.created_at).toISOString(),
  }
}

export function formatExecution(e: ExecutionRow): FormattedExecution {
  return {
    taskId: e.task_id,
    ranAt: e.ran_at,
    ranAtIso: new Date(e.ran_at).toISOString(),
    status: e.status,
    error: e.error,
  }
}

// ===========================================================================
// Pagination cursor helpers (same encoding as MCA db)
// ===========================================================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export function clampLimit(limit?: number): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

export function encodeCursor(timestamp: number, id: number): string {
  return Buffer.from(`${timestamp}:${id}`).toString('base64url')
}

export function decodeCursor(cursor: string): { timestamp: number; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    const [ts, id] = decoded.split(':')
    if (!ts || !id) return null
    return { timestamp: Number(ts), id: Number(id) }
  } catch {
    return null
  }
}
