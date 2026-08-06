/**
 * Scheduler domain WS handlers.
 *
 * Each factory returns a handler `(ctx, rawData) => result`. The result shape
 * is identical to the MCA tool output's `structuredContent` field — MCP
 * envelope ({content, structuredContent}) is only added by the MCA, not here.
 *
 * Criterio 22: shapes here MUST mirror `mcas/mca.teros.scheduler/src/tools/*.ts`.
 *
 * TER-358 — Capa 1 (backend mirror): cada handler extrae `ctx.userId` y lo
 * propaga al store. Las mutaciones son atómicas (filter compuesto
 * `{id, user_id, status?}`). Sin userId no se persiste ni se lee nada.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import { z, type ZodTypeAny } from 'zod'
import {
  assertChannelOwnership,
  assertValidChannelId,
  assertValidCron,
  assertValidTimezone,
  describeCronExpression,
  formatExecution,
  formatNextRun,
  formatRecurringTask,
  formatReminder,
  type GetChannelOwner,
  getNextCronRun,
  isValidCronExpression,
  parseDelayExpression,
  parseTimeExpression,
  previewCronOccurrences,
  resolveDefaultTimezone,
  SchedulerError,
} from './_helpers'
import type { SchedulerStore } from './store'

// ---------------------------------------------------------------------------
// Bridge SchedulerError <-> HandlerError
// ---------------------------------------------------------------------------

function toHandlerError(error: unknown): never {
  if (error instanceof SchedulerError) {
    const suggestion = error.suggestion ? ` ${error.suggestion}` : ''
    throw new HandlerError(error.code, `${error.message}${suggestion}`)
  }
  throw error
}

function parseInput<T extends ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw ?? {})
  if (!parsed.success) {
    const issue = parsed.error.errors[0]
    const path = issue.path.length > 0 ? issue.path.join('.') : '<input>'
    throw new HandlerError('INVALID_INPUT', `Invalid input at "${path}": ${issue.message}`)
  }
  return parsed.data
}

/**
 * Capa 1: extrae `userId` del WS handler context. WsHandlerContext.userId es
 * REQUIRED por el framework — si faltara es un bug del auth middleware.
 */
function requireUserId(ctx: WsHandlerContext): string {
  if (!ctx.userId || ctx.userId.trim() === '') {
    throw new HandlerError('NO_USER_CONTEXT', 'WsHandlerContext.userId missing')
  }
  return ctx.userId
}

// ---------------------------------------------------------------------------
// parse-time-expression (no toca DB ni necesita userId)
// ---------------------------------------------------------------------------

const ParseSchema = z.object({
  expression: z.string().min(1),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  previewCount: z.number().int().min(1).max(20).optional(),
  reference: z.string().datetime().optional(),
})

export function createParseTimeHandler() {
  return async (_ctx: WsHandlerContext, raw: unknown) => {
    try {
      const input = parseInput(ParseSchema, raw)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      assertValidTimezone(timezone)
      const reference = input.reference ? new Date(input.reference) : new Date()
      const previewCount = input.previewCount ?? 5
      const trimmed = input.expression.trim()

      const ISO_REGEX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/
      if (ISO_REGEX.test(trimmed)) {
        const parsed = parseTimeExpression(input.expression, {
          reference,
          timezone,
          locale: input.locale,
          allowPast: true,
        })
        return {
          kind: 'iso' as const,
          expression: input.expression,
          timezone,
          confidence: parsed.confidence,
          parsed: {
            timestamp: parsed.timestamp,
            iso: parsed.date.toISOString(),
            humanReadable: formatNextRun(parsed.timestamp, timezone),
          },
        }
      }

      if (/\s/.test(trimmed) && isValidCronExpression(input.expression)) {
        const occurrences = previewCronOccurrences(input.expression, timezone, previewCount)
        return {
          kind: 'cron' as const,
          expression: input.expression,
          description: describeCronExpression(input.expression),
          timezone,
          nextOccurrences: occurrences.map((ts) => ({
            timestamp: ts,
            iso: new Date(ts).toISOString(),
            humanReadable: formatNextRun(ts, timezone),
          })),
        }
      }

      const parsed = parseTimeExpression(input.expression, {
        reference,
        timezone,
        locale: input.locale,
        allowPast: true,
      })
      return {
        kind: 'natural' as const,
        expression: input.expression,
        timezone,
        locale: parsed.locale,
        confidence: parsed.confidence,
        detectedText: parsed.detectedText,
        parsed: {
          timestamp: parsed.timestamp,
          iso: parsed.date.toISOString(),
          humanReadable: formatNextRun(parsed.timestamp, timezone),
        },
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

// ---------------------------------------------------------------------------
// get-stats — per-user
// ---------------------------------------------------------------------------

const StatsSchema = z.object({ timezone: z.string().optional() })

export function createGetStatsHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(StatsSchema, raw ?? {})
      const timezone = input.timezone ?? resolveDefaultTimezone()
      const [reminders, recurringTasks, nextScheduledAt] = await Promise.all([
        store.countActiveReminders(userId),
        store.countActiveRecurringTasks(userId),
        store.getNextScheduledTimestamp(userId),
      ])
      return {
        active: { reminders, recurringTasks },
        nextScheduledAt,
        nextScheduledIso: nextScheduledAt ? new Date(nextScheduledAt).toISOString() : null,
        nextScheduledHumanReadable: nextScheduledAt ? formatNextRun(nextScheduledAt, timezone) : null,
        timezone,
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

const ScheduleReminderSchema = z.object({
  time: z.string().min(1),
  message: z.string().min(1).max(4000),
  channelId: z.string().min(1),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  allowPast: z.boolean().optional(),
})

export function createScheduleReminderHandler(store: SchedulerStore, getChannelOwner: GetChannelOwner) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ScheduleReminderSchema, raw)
      // Mismo orden que el MCA: shape del channelId → ownership → timezone.
      assertValidChannelId(input.channelId)
      await assertChannelOwnership(getChannelOwner, userId, input.channelId)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      assertValidTimezone(timezone)
      const parsed = parseTimeExpression(input.time, {
        timezone,
        locale: input.locale,
        allowPast: input.allowPast,
      })
      const reminder = await store.createReminder(
        userId,
        input.channelId,
        input.message,
        parsed.timestamp,
        timezone,
      )
      return { action: 'created' as const, reminder: formatReminder(reminder, timezone) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const ListRemindersSchema = z.object({
  channelId: z.string().optional(),
  status: z.enum(['pending', 'sent', 'cancelled', 'failed']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  timezone: z.string().optional(),
})

export function createListRemindersHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ListRemindersSchema, raw)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      const page = await store.listReminders({ ...input, userId })
      return {
        items: page.items.map((r) => formatReminder(r, timezone)),
        nextCursor: page.nextCursor,
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const ListUpcomingSchema = z.object({
  channelId: z.string().optional(),
  days: z.number().int().min(1).max(90).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  timezone: z.string().optional(),
  include: z.enum(['reminders', 'recurring', 'both']).optional(),
})

export function createListUpcomingHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ListUpcomingSchema, raw)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      const days = input.days ?? 7
      const include = input.include ?? 'both'
      const now = Date.now()
      const horizon = now + days * 86_400_000
      const remindersPage =
        include === 'recurring'
          ? { items: [], nextCursor: undefined as string | undefined }
          : await store.listReminders({
              userId,
              channelId: input.channelId,
              status: 'pending',
              scheduledAfter: now,
              scheduledBefore: horizon,
              limit: input.limit,
              cursor: input.cursor,
            })
      const tasksPage =
        include === 'reminders'
          ? { items: [], nextCursor: undefined as string | undefined }
          : await store.listRecurringTasks({
              userId,
              channelId: input.channelId,
              enabled: true,
              limit: input.limit,
            })
      return {
        windowDays: days,
        windowEndAt: horizon,
        windowEndIso: new Date(horizon).toISOString(),
        reminders: remindersPage.items.map((r) => formatReminder(r, timezone)),
        nextCursor: remindersPage.nextCursor,
        recurringTasks: tasksPage.items.filter((t) => t.next_run <= horizon).map((t) => formatRecurringTask(t)),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const ReminderIdSchema = z.object({
  reminderId: z.number().int().positive(),
  timezone: z.string().optional(),
})

export function createGetReminderHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ReminderIdSchema, raw)
      const reminder = await store.getReminder(input.reminderId, userId)
      if (!reminder) throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      return { reminder: formatReminder(reminder, timezone) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const UpdateReminderSchema = z
  .object({
    reminderId: z.number().int().positive(),
    time: z.string().min(1).optional(),
    message: z.string().min(1).max(4000).optional(),
    timezone: z.string().optional(),
    locale: z.enum(['en', 'es']).optional(),
    allowPast: z.boolean().optional(),
  })
  .refine((v) => v.time !== undefined || v.message !== undefined, {
    message: 'At least one of "time" or "message" is required.',
  })

export function createUpdateReminderHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(UpdateReminderSchema, raw)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      assertValidTimezone(timezone)
      const patch: { message?: string; scheduled_time?: number } = {}
      if (input.message !== undefined) patch.message = input.message
      if (input.time !== undefined) {
        const parsed = parseTimeExpression(input.time, {
          timezone,
          locale: input.locale,
          allowPast: input.allowPast,
        })
        patch.scheduled_time = parsed.timestamp
      }
      const updated = await store.updateReminder(input.reminderId, userId, patch)
      if (!updated) {
        const current = await store.getReminder(input.reminderId, userId)
        if (!current) throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`)
        throw new SchedulerError('ALREADY_TERMINAL', `Reminder is ${current.status}.`)
      }
      return {
        action: 'updated' as const,
        changedFields: Object.keys(patch),
        reminder: formatReminder(updated, timezone),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const SnoozeSchema = z.object({
  reminderId: z.number().int().positive(),
  delay: z.string().min(1),
  timezone: z.string().optional(),
})

export function createSnoozeReminderHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(SnoozeSchema, raw)
      const delayMs = parseDelayExpression(input.delay)
      const newScheduled = Date.now() + delayMs
      const updated = await store.updateReminder(input.reminderId, userId, {
        scheduled_time: newScheduled,
      })
      if (!updated) {
        const current = await store.getReminder(input.reminderId, userId)
        if (!current) throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`)
        throw new SchedulerError('ALREADY_TERMINAL', `Reminder is ${current.status}.`)
      }
      const timezone = input.timezone ?? resolveDefaultTimezone()
      return {
        action: 'snoozed' as const,
        delayMs,
        reminder: formatReminder(updated, timezone),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

export function createCancelReminderHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ReminderIdSchema, raw)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      const cancelled = await store.cancelReminder(input.reminderId, userId)
      if (!cancelled) {
        const current = await store.getReminder(input.reminderId, userId)
        if (!current) throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`)
        return {
          action: 'noop' as const,
          reminder: formatReminder(current, timezone),
          reason: `Already ${current.status}.`,
        }
      }
      return { action: 'cancelled' as const, reminder: formatReminder(cancelled, timezone) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const BulkCancelBefore = z.union([
  z.number().int().positive(),
  z
    .string()
    .min(1)
    .refine(
      (s) => /^\d+$/.test(s) || !Number.isNaN(new Date(s).getTime()),
      'Must be epoch ms (number or numeric string) or ISO 8601 datetime.',
    )
    .transform((s) => (/^\d+$/.test(s) ? Number(s) : new Date(s).getTime())),
])

const BulkCancelSchema = z
  .object({
    channelId: z.string().optional(),
    before: BulkCancelBefore.optional(),
    ids: z.array(z.number().int().positive()).max(500).optional(),
    timezone: z.string().optional(),
  })
  .refine((v) => v.channelId !== undefined || v.before !== undefined || (v.ids && v.ids.length > 0), {
    message: 'Provide at least one filter: channelId, before, or ids[].',
  })

export function createBulkCancelHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(BulkCancelSchema, raw)
      const cancelledIds = await store.bulkCancelReminders({
        userId,
        channelId: input.channelId,
        before: input.before,
        ids: input.ids,
      })
      return {
        action: 'bulk-cancelled' as const,
        cancelledCount: cancelledIds.length,
        cancelledIds,
        timezone: input.timezone ?? resolveDefaultTimezone(),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

// ---------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------

const CreateRecurringSchema = z.object({
  cronExpression: z.string().min(1),
  message: z.string().min(1).max(4000),
  channelId: z.string().min(1),
  timezone: z.string().optional(),
})

export function createCreateRecurringTaskHandler(store: SchedulerStore, getChannelOwner: GetChannelOwner) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(CreateRecurringSchema, raw)
      // Mismo orden que el MCA: shape del channelId → ownership → timezone.
      assertValidChannelId(input.channelId)
      await assertChannelOwnership(getChannelOwner, userId, input.channelId)
      const timezone = input.timezone ?? resolveDefaultTimezone()
      assertValidTimezone(timezone)
      assertValidCron(input.cronExpression)
      const nextRun = getNextCronRun(input.cronExpression, timezone)
      const task = await store.createRecurringTask(
        userId,
        input.channelId,
        input.message,
        input.cronExpression,
        nextRun,
        timezone,
      )
      return { action: 'created' as const, task: formatRecurringTask(task) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const ListRecurringSchema = z.object({
  channelId: z.string().optional(),
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
})

export function createListRecurringTasksHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ListRecurringSchema, raw)
      const page = await store.listRecurringTasks({ ...input, userId })
      return { items: page.items.map(formatRecurringTask), nextCursor: page.nextCursor }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const TaskIdSchema = z.object({ taskId: z.number().int().positive() })

export function createGetRecurringTaskHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(TaskIdSchema, raw)
      const task = await store.getRecurringTask(input.taskId, userId)
      if (!task) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      return { task: formatRecurringTask(task) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const UpdateRecurringSchema = z
  .object({
    taskId: z.number().int().positive(),
    cronExpression: z.string().min(1).optional(),
    message: z.string().min(1).max(4000).optional(),
    timezone: z.string().optional(),
  })
  .refine((v) => v.cronExpression !== undefined || v.message !== undefined || v.timezone !== undefined, {
    message: 'Provide at least one of cronExpression, message or timezone.',
  })

export function createUpdateRecurringTaskHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(UpdateRecurringSchema, raw)
      const existing = await store.getRecurringTask(input.taskId, userId)
      if (!existing) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      const patch: { cron_expression?: string; message?: string; timezone?: string; next_run?: number } = {}
      const newCron = input.cronExpression ?? existing.cron_expression
      const newTz = input.timezone ?? existing.timezone
      if (input.cronExpression !== undefined) {
        assertValidCron(input.cronExpression)
        patch.cron_expression = input.cronExpression
      }
      if (input.timezone !== undefined) {
        assertValidTimezone(input.timezone)
        patch.timezone = input.timezone
      }
      if (input.message !== undefined) patch.message = input.message
      if (input.cronExpression !== undefined || input.timezone !== undefined) {
        patch.next_run = getNextCronRun(newCron, newTz)
      }
      const updated = await store.updateRecurringTask(input.taskId, userId, patch)
      if (!updated) throw new SchedulerError('NOT_FOUND', `Recurring task vanished during update.`)
      return {
        action: 'updated' as const,
        changedFields: Object.keys(patch),
        task: formatRecurringTask(updated),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

export function createEnableRecurringTaskHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(TaskIdSchema, raw)
      const existing = await store.getRecurringTask(input.taskId, userId)
      if (!existing) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      const nextRun = getNextCronRun(existing.cron_expression, existing.timezone)
      const updated = await store.updateRecurringTask(input.taskId, userId, {
        enabled: true,
        next_run: nextRun,
      })
      if (!updated) throw new SchedulerError('NOT_FOUND', `Recurring task vanished during enable.`)
      return {
        action: existing.enabled ? ('noop' as const) : ('enabled' as const),
        task: formatRecurringTask(updated),
      }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

export function createDisableRecurringTaskHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(TaskIdSchema, raw)
      const updated = await store.setRecurringEnabled(input.taskId, userId, false)
      if (!updated) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      return { action: 'disabled' as const, task: formatRecurringTask(updated) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

export function createDeleteRecurringTaskHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(TaskIdSchema, raw)
      const deleted = await store.deleteRecurringTask(input.taskId, userId)
      if (!deleted) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      return { action: 'deleted' as const, task: formatRecurringTask(deleted) }
    } catch (e) {
      toHandlerError(e)
    }
  }
}

const ListExecutionsSchema = z.object({
  taskId: z.number().int().positive(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
})

export function createListExecutionsHandler(store: SchedulerStore) {
  return async (ctx: WsHandlerContext, raw: unknown) => {
    try {
      const userId = requireUserId(ctx)
      const input = parseInput(ListExecutionsSchema, raw)
      const task = await store.getRecurringTask(input.taskId, userId)
      if (!task) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`)
      const page = await store.listExecutions({
        userId,
        taskId: input.taskId,
        limit: input.limit,
        cursor: input.cursor,
      })
      return { taskId: input.taskId, items: page.items.map(formatExecution), nextCursor: page.nextCursor }
    } catch (e) {
      toHandlerError(e)
    }
  }
}
