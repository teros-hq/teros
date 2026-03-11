#!/usr/bin/env bun

/**
 * Scheduler MCA v1.0
 *
 * Schedule reminders and recurring tasks using McaServer with automatic transport detection.
 * Data is stored in MongoDB. Background tasks check for due reminders/tasks every 30s.
 */

import { McaServer } from '@teros/mca-sdk';
import { getNextRunTime } from './cron-helper';
import { db } from './lib';
import { formatTime } from './time-parser';
import {
  cancelReminder,
  createRecurringTask,
  deleteRecurringTask,
  disableRecurringTask,
  enableRecurringTask,
  listRecurringTasks,
  listReminders,
  scheduleReminder,
} from './tools';

// =============================================================================
// CONFIGURATION
// =============================================================================

const API_URL = process.env.TEROS_API_URL || 'http://localhost:10001';
const EVENT_ENDPOINT = `${API_URL}/api/event`;

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.scheduler',
  name: 'Scheduler',
  version: '1.0.0',
});

// =============================================================================
// REGISTER TOOLS
// =============================================================================

server.tool('schedule-reminder', scheduleReminder);
server.tool('list-reminders', listReminders);
server.tool('cancel-reminder', cancelReminder);
server.tool('create-recurring-task', createRecurringTask);
server.tool('list-recurring-tasks', listRecurringTasks);
server.tool('enable-recurring-task', enableRecurringTask);
server.tool('disable-recurring-task', disableRecurringTask);
server.tool('delete-recurring-task', deleteRecurringTask);

// =============================================================================
// BACKGROUND TASKS
// =============================================================================

async function checkReminders(): Promise<void> {
  try {
    const pending = await db.getPendingReminders();

    for (const reminder of pending) {
      try {
        const response = await fetch(EVENT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channelId: reminder.channel_id,
            message: reminder.message,
            eventType: 'reminder',
            wakeUpAgent: true,
            metadata: {
              source: 'scheduler',
              reminderId: reminder.id,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${await response.text()}`);
        }

        await db.markAsSent(reminder.id!);
        console.error(`✅ Sent reminder ${reminder.id} to channel ${reminder.channel_id}`);
      } catch (error) {
        console.error(
          `❌ Failed to send reminder ${reminder.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } catch (error) {
    console.error(
      '❌ Error checking reminders:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function checkRecurringTasks(): Promise<void> {
  try {
    const dueTasks = await db.getDueRecurringTasks();

    for (const task of dueTasks) {
      try {
        const response = await fetch(EVENT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            channelId: task.channel_id,
            message: task.message,
            eventType: 'recurring_task',
            wakeUpAgent: true,
            metadata: {
              source: 'scheduler',
              taskId: task.id,
              cronExpression: task.cron_expression,
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${await response.text()}`);
        }

        // Calculate next run time
        const nextRun = getNextRunTime(task.cron_expression, task.timezone);
        await db.updateRecurringTaskNextRun(task.id!, nextRun, Date.now());

        console.error(`✅ Executed recurring task ${task.id}, next run: ${formatTime(nextRun)}`);
      } catch (error) {
        console.error(
          `❌ Failed to execute recurring task ${task.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } catch (error) {
    console.error(
      '❌ Error checking recurring tasks:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

// =============================================================================
// START SERVER
// =============================================================================

async function main(): Promise<void> {
  // Initialize database connection
  await db.connect();

  // Start background task checkers
  setInterval(checkReminders, 30000);
  setInterval(checkRecurringTasks, 30000);

  // Run initial checks
  checkReminders();
  checkRecurringTasks();

  // Start the MCA server
  await server.start();
  console.error('Scheduler MCA running (checking reminders & recurring tasks every 30s)');
}

main().catch((error) => {
  console.error('[Scheduler MCA] Fatal error:', error);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await db.close();
  process.exit(0);
});
