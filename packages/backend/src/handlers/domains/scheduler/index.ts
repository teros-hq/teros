/**
 * Scheduler domain — registers all WS handlers.
 *

 * Actions:
 *   scheduler.get-stats
 *   scheduler.parse-time-expression
 *   scheduler.schedule-reminder
 *   scheduler.list-reminders
 *   scheduler.list-upcoming
 *   scheduler.get-reminder
 *   scheduler.update-reminder
 *   scheduler.snooze-reminder
 *   scheduler.cancel-reminder
 *   scheduler.bulk-cancel
 *   scheduler.create-recurring-task
 *   scheduler.list-recurring-tasks
 *   scheduler.get-recurring-task
 *   scheduler.update-recurring-task
 *   scheduler.enable-recurring-task
 *   scheduler.disable-recurring-task
 *   scheduler.delete-recurring-task
 *   scheduler.list-executions
 */

import type { Db } from 'mongodb'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import {
  createBulkCancelHandler,
  createCancelReminderHandler,
  createCreateRecurringTaskHandler,
  createDeleteRecurringTaskHandler,
  createDisableRecurringTaskHandler,
  createEnableRecurringTaskHandler,
  createGetRecurringTaskHandler,
  createGetReminderHandler,
  createGetStatsHandler,
  createListExecutionsHandler,
  createListRecurringTasksHandler,
  createListRemindersHandler,
  createListUpcomingHandler,
  createParseTimeHandler,
  createScheduleReminderHandler,
  createSnoozeReminderHandler,
  createUpdateRecurringTaskHandler,
  createUpdateReminderHandler,
} from './handlers'
import { SchedulerStore } from './store'

export interface SchedulerDomainDeps {
  db: Db
}

export function register(router: WsRouter, deps: SchedulerDomainDeps): void {
  const store = new SchedulerStore(deps.db)
  // Resolver del owner del canal (owner ESTRICTO `channel.userId`) — misma
  // semántica que `getChannelOwnerUserIdFn` del bootstrap (Capas 2/3/4) y que
  // el MCA `assertChannelOwnership` (criterio 22).
  const getChannelOwner = async (channelId: string): Promise<string | null> => {
    const channel = await deps.db
      .collection<{ channelId: string; userId?: string }>('channels')
      .findOne({ channelId }, { projection: { userId: 1 } })
    return channel?.userId ?? null
  }

  router.register('scheduler.get-stats', createGetStatsHandler(store))
  router.register('scheduler.parse-time-expression', createParseTimeHandler())

  // Reminders
  router.register('scheduler.schedule-reminder', createScheduleReminderHandler(store, getChannelOwner))
  router.register('scheduler.list-reminders', createListRemindersHandler(store))
  router.register('scheduler.list-upcoming', createListUpcomingHandler(store))
  router.register('scheduler.get-reminder', createGetReminderHandler(store))
  router.register('scheduler.update-reminder', createUpdateReminderHandler(store))
  router.register('scheduler.snooze-reminder', createSnoozeReminderHandler(store))
  router.register('scheduler.cancel-reminder', createCancelReminderHandler(store))
  router.register('scheduler.bulk-cancel', createBulkCancelHandler(store))

  // Recurring tasks
  router.register('scheduler.create-recurring-task', createCreateRecurringTaskHandler(store, getChannelOwner))
  router.register('scheduler.list-recurring-tasks', createListRecurringTasksHandler(store))
  router.register('scheduler.get-recurring-task', createGetRecurringTaskHandler(store))
  router.register('scheduler.update-recurring-task', createUpdateRecurringTaskHandler(store))
  router.register('scheduler.enable-recurring-task', createEnableRecurringTaskHandler(store))
  router.register('scheduler.disable-recurring-task', createDisableRecurringTaskHandler(store))
  router.register('scheduler.delete-recurring-task', createDeleteRecurringTaskHandler(store))

  // Execution history
  router.register('scheduler.list-executions', createListExecutionsHandler(store))
}

export { SchedulerStore } from './store'
export * from './_helpers'
