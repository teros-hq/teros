/**
 * Thin wrapper over the same MongoDB collections used by the MCA
 * (`scheduler_reminders`, `scheduler_recurring_tasks`, `scheduler_executions`,
 * `scheduler_counters`).
 *
 * Both the WsRouter handlers (this file) and the MCA tools
 * (`mcas/mca.teros.scheduler/src/db.ts`) read/write the same data — the store
 * keeps the WsRouter side decoupled from the MCA package.
 *
 * **TER-358 (Capa 1 backend mirror)**: cada query exige `userId` REQUIRED.
 * Las mutaciones usan filter compuesto `{id, user_id, ...}` en una sola
 * findOneAndUpdate/findOneAndDelete (no read-before-write). Counter per-user
 * para que dos usuarios obtengan ids 1..N sin colisión.
 */

import type { Collection, Db, Filter, ObjectId } from 'mongodb'
import {
  type BulkCancelFilter,
  type Execution,
  type ExecutionsQuery,
  ORPHANED_USER_ID,
  type PageResult,
  type Reminder,
  type RemindersQuery,
  type RecurringTask,
  type RecurringTasksQuery,
} from '@teros/shared'
import { clampLimit, decodeCursor, encodeCursor } from './_helpers'

// Re-export para que handlers.ts importe los tipos canónicos via este módulo.
export type {
  Reminder as ReminderRow,
  RecurringTask as RecurringTaskRow,
  Execution as ExecutionRow,
  PageResult,
  RemindersQuery,
  RecurringTasksQuery,
  BulkCancelFilter,
  ExecutionsQuery,
} from '@teros/shared'

const MAX_BULK_CANCEL = 5000

export class SchedulerStore {
  private reminders: Collection<Reminder & { _id?: ObjectId }>
  private recurringTasks: Collection<RecurringTask & { _id?: ObjectId }>
  private executions: Collection<Execution & { _id?: ObjectId }>
  private counters: Collection<{ _id: string; seq: number }>

  constructor(db: Db) {
    this.reminders = db.collection('scheduler_reminders')
    this.recurringTasks = db.collection('scheduler_recurring_tasks')
    this.executions = db.collection('scheduler_executions')
    this.counters = db.collection('scheduler_counters')
  }

  /**
   * Counter per-user. Mismo patrón que el MCA: `_id: '<name>:<userId>'`.
   * Cada user empieza fresh en 1. Los ids siguen siendo cortos en prompts del
   * LLM porque viven dentro del scope user.
   */
  private async nextSeq(userId: string, name: 'reminders' | 'recurring_tasks'): Promise<number> {
    const result = await this.counters.findOneAndUpdate(
      { _id: `${name}:${userId}` },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true },
    )
    if (!result?.seq || result.seq < 1) {
      throw new Error(`Counter '${name}:${userId}' returned invalid seq: ${result?.seq}`)
    }
    return result.seq
  }

  // ===========================================================================
  // Reminders
  // ===========================================================================

  async createReminder(
    userId: string,
    channelId: string,
    message: string,
    scheduledTime: number,
    timezone?: string,
    workspaceId?: string,
  ): Promise<Reminder> {
    const id = await this.nextSeq(userId, 'reminders')
    const reminder: Reminder = {
      id,
      user_id: userId,
      channel_id: channelId,
      message,
      scheduled_time: scheduledTime,
      created_at: Date.now(),
      status: 'pending',
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
      ...(timezone ? { timezone } : {}),
    }
    await this.reminders.insertOne(reminder as Reminder & { _id?: ObjectId })
    return reminder
  }

  async getReminder(id: number, userId: string): Promise<Reminder | null> {
    return await this.reminders.findOne({ id, user_id: userId })
  }

  async updateReminder(
    id: number,
    userId: string,
    patch: Partial<Pick<Reminder, 'message' | 'scheduled_time' | 'timezone'>>,
  ): Promise<Reminder | null> {
    const set: Record<string, unknown> = {}
    if (patch.message !== undefined) set.message = patch.message
    if (patch.scheduled_time !== undefined) set.scheduled_time = patch.scheduled_time
    if (patch.timezone !== undefined) set.timezone = patch.timezone
    if (Object.keys(set).length === 0) return await this.reminders.findOne({ id, user_id: userId })
    const result = await this.reminders.findOneAndUpdate(
      { id, user_id: userId, status: 'pending' },
      { $set: set },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async cancelReminder(id: number, userId: string): Promise<Reminder | null> {
    const result = await this.reminders.findOneAndUpdate(
      { id, user_id: userId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async listReminders(query: RemindersQuery): Promise<PageResult<Reminder>> {
    const limit = clampLimit(query.limit)
    const filter: Filter<Reminder> = { user_id: query.userId }
    if (query.channelId) filter.channel_id = query.channelId
    if (query.status) filter.status = query.status
    if (query.scheduledBefore !== undefined) {
      filter.scheduled_time = { ...(filter.scheduled_time as object | undefined), $lte: query.scheduledBefore }
    }
    if (query.scheduledAfter !== undefined) {
      filter.scheduled_time = { ...(filter.scheduled_time as object | undefined), $gte: query.scheduledAfter }
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor)
      if (c) {
        filter.$or = [
          { scheduled_time: { $gt: c.timestamp } },
          { scheduled_time: c.timestamp, id: { $gt: c.id } },
        ]
      }
    }
    const items = await this.reminders.find(filter).sort({ scheduled_time: 1, id: 1 }).limit(limit + 1).toArray()
    const hasMore = items.length > limit
    const sliced = hasMore ? items.slice(0, limit) : items
    const last = sliced[sliced.length - 1]
    return {
      items: sliced,
      nextCursor: hasMore && last?.id !== undefined ? encodeCursor(last.scheduled_time, last.id) : undefined,
    }
  }

  async bulkCancelReminders(filter: BulkCancelFilter): Promise<number[]> {
    const mongoFilter: Filter<Reminder> = { user_id: filter.userId, status: 'pending' }
    if (filter.channelId) mongoFilter.channel_id = filter.channelId
    if (filter.before !== undefined) mongoFilter.scheduled_time = { $lte: filter.before }
    if (filter.ids && filter.ids.length > 0) mongoFilter.id = { $in: filter.ids }
    const totalCount = await this.reminders.countDocuments(mongoFilter)
    if (totalCount > MAX_BULK_CANCEL) {
      throw new Error(
        `Bulk cancel would affect ${totalCount} reminders (cap: ${MAX_BULK_CANCEL}). Narrow your filter or call multiple times.`,
      )
    }
    const matching = await this.reminders.find(mongoFilter, { projection: { id: 1, _id: 0 } }).toArray()
    const ids = matching.map((m) => m.id).filter((v): v is number => typeof v === 'number')
    if (ids.length > 0) {
      await this.reminders.updateMany(
        { id: { $in: ids }, user_id: filter.userId, status: 'pending' },
        { $set: { status: 'cancelled' } },
      )
    }
    return ids
  }

  async countActiveReminders(userId: string): Promise<number> {
    return await this.reminders.countDocuments({ user_id: userId, status: 'pending' })
  }

  async countActiveRecurringTasks(userId: string): Promise<number> {
    return await this.recurringTasks.countDocuments({ user_id: userId, enabled: true })
  }

  async getNextScheduledTimestamp(userId: string): Promise<number | null> {
    const reminder = await this.reminders.findOne(
      { user_id: userId, status: 'pending' },
      { sort: { scheduled_time: 1 }, projection: { scheduled_time: 1, _id: 0 } },
    )
    const task = await this.recurringTasks.findOne(
      { user_id: userId, enabled: true },
      { sort: { next_run: 1 }, projection: { next_run: 1, _id: 0 } },
    )
    const r = reminder?.scheduled_time
    const t = task?.next_run
    if (r === undefined && t === undefined) return null
    if (r === undefined) return t!
    if (t === undefined) return r
    return Math.min(r, t)
  }

  // ===========================================================================
  // Recurring tasks
  // ===========================================================================

  async createRecurringTask(
    userId: string,
    channelId: string,
    message: string,
    cronExpression: string,
    nextRun: number,
    timezone: string,
    workspaceId?: string,
  ): Promise<RecurringTask> {
    const id = await this.nextSeq(userId, 'recurring_tasks')
    const task: RecurringTask = {
      id,
      user_id: userId,
      channel_id: channelId,
      message,
      cron_expression: cronExpression,
      timezone,
      enabled: true,
      next_run: nextRun,
      created_at: Date.now(),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    }
    await this.recurringTasks.insertOne(task as RecurringTask & { _id?: ObjectId })
    return task
  }

  async getRecurringTask(id: number, userId: string): Promise<RecurringTask | null> {
    return await this.recurringTasks.findOne({ id, user_id: userId })
  }

  async updateRecurringTask(
    id: number,
    userId: string,
    patch: Partial<Pick<RecurringTask, 'message' | 'cron_expression' | 'timezone' | 'next_run' | 'enabled'>>,
  ): Promise<RecurringTask | null> {
    const set: Record<string, unknown> = {}
    if (patch.message !== undefined) set.message = patch.message
    if (patch.cron_expression !== undefined) set.cron_expression = patch.cron_expression
    if (patch.timezone !== undefined) set.timezone = patch.timezone
    if (patch.next_run !== undefined) set.next_run = patch.next_run
    if (patch.enabled !== undefined) set.enabled = patch.enabled
    if (Object.keys(set).length === 0) return await this.recurringTasks.findOne({ id, user_id: userId })
    const result = await this.recurringTasks.findOneAndUpdate(
      { id, user_id: userId },
      { $set: set },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async setRecurringEnabled(id: number, userId: string, enabled: boolean): Promise<RecurringTask | null> {
    const result = await this.recurringTasks.findOneAndUpdate(
      { id, user_id: userId },
      { $set: { enabled } },
      { returnDocument: 'after' },
    )
    return result ?? null
  }

  async deleteRecurringTask(id: number, userId: string): Promise<RecurringTask | null> {
    const result = await this.recurringTasks.findOneAndDelete({ id, user_id: userId })
    return result ?? null
  }

  async listRecurringTasks(query: RecurringTasksQuery): Promise<PageResult<RecurringTask>> {
    const limit = clampLimit(query.limit)
    const filter: Filter<RecurringTask> = { user_id: query.userId }
    if (query.channelId) filter.channel_id = query.channelId
    if (query.enabled !== undefined) filter.enabled = query.enabled
    if (query.cursor) {
      const c = decodeCursor(query.cursor)
      if (c) {
        filter.$or = [
          { next_run: { $gt: c.timestamp } },
          { next_run: c.timestamp, id: { $gt: c.id } },
        ]
      }
    }
    const items = await this.recurringTasks.find(filter).sort({ next_run: 1, id: 1 }).limit(limit + 1).toArray()
    const hasMore = items.length > limit
    const sliced = hasMore ? items.slice(0, limit) : items
    const last = sliced[sliced.length - 1]
    return {
      items: sliced,
      nextCursor: hasMore && last?.id !== undefined ? encodeCursor(last.next_run, last.id) : undefined,
    }
  }

  // ===========================================================================
  // Executions
  // ===========================================================================

  async listExecutions(query: ExecutionsQuery): Promise<PageResult<Execution>> {
    const cap = clampLimit(query.limit)
    const filter: Filter<Execution> = { user_id: query.userId, task_id: query.taskId }
    if (query.cursor) {
      const c = decodeCursor(query.cursor)
      if (c) filter.ran_at = { $lt: c.timestamp }
    }
    const items = await this.executions.find(filter).sort({ ran_at: -1 }).limit(cap + 1).toArray()
    const hasMore = items.length > cap
    const sliced = hasMore ? items.slice(0, cap) : items
    const last = sliced[sliced.length - 1]
    return {
      items: sliced,
      nextCursor: hasMore && last ? encodeCursor(last.ran_at, last.task_id) : undefined,
    }
  }
}

// Quietly reference ORPHANED_USER_ID to surface the constant through the
// import chain — useful for tests that exercise orphan-skip logic via the
// store's collections.
export { ORPHANED_USER_ID }
