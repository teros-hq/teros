#!/usr/bin/env bun

/**
 * Scheduler MCA v1.0.0
 *
 * One-shot reminders + cron-driven recurring tasks. Time expressions parsed
 * with chrono-node (en+es); recurrence with croner. Data stored in MongoDB.
 *
 * Execution loop lives in packages/backend/src/services/scheduler-service.ts
 * which polls the same collections every 30 s and dispatches events via the
 * MCA event subscription service. This MCA only owns CRUD + previews + health.
 */

import { McaServer } from '@teros/mca-sdk';
import { db } from './lib';
import {
  bulkCancel,
  cancelReminder,
  createRecurringTask,
  deleteRecurringTask,
  disableRecurringTask,
  enableRecurringTask,
  getRecurringTask,
  getReminder,
  getStats,
  healthCheck,
  listExecutions,
  listRecurringTasks,
  listReminders,
  listUpcoming,
  parseTimeExpressionTool,
  scheduleReminder,
  snoozeReminder,
  updateRecurringTask,
  updateReminder,
} from './tools';

const server = new McaServer({
  id: 'mca.teros.scheduler',
  name: 'Scheduler',
  version: '1.0.0',
});

// Internal
server.tool('-health-check', healthCheck);
server.tool('get-stats', getStats);

// Time tooling
server.tool('parse-time-expression', parseTimeExpressionTool);

// Reminders
server.tool('schedule-reminder', scheduleReminder);
server.tool('list-reminders', listReminders);
server.tool('list-upcoming', listUpcoming);
server.tool('get-reminder', getReminder);
server.tool('update-reminder', updateReminder);
server.tool('snooze-reminder', snoozeReminder);
server.tool('cancel-reminder', cancelReminder);
server.tool('bulk-cancel', bulkCancel);

// Recurring tasks
server.tool('create-recurring-task', createRecurringTask);
server.tool('list-recurring-tasks', listRecurringTasks);
server.tool('get-recurring-task', getRecurringTask);
server.tool('update-recurring-task', updateRecurringTask);
server.tool('enable-recurring-task', enableRecurringTask);
server.tool('disable-recurring-task', disableRecurringTask);
server.tool('delete-recurring-task', deleteRecurringTask);

// Execution history
server.tool('list-executions', listExecutions);

async function main(): Promise<void> {
  await db.connect();
  await server.start();
  console.error('Scheduler MCA running (CRUD + preview + history; execution by backend SchedulerService)');
}

main().catch((error) => {
  console.error('[Scheduler MCA] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await db.close();
  process.exit(0);
});
