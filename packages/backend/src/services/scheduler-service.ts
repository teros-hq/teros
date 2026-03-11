/**
 * Scheduler Service
 *
 * Runs as part of the backend process and checks for due reminders
 * and recurring tasks every 30 seconds.
 *
 * Uses MongoDB (same database as the Scheduler MCA) for persistence.
 * The MCA handles CRUD operations, this service handles execution.
 */

// Cron parsing using croner
import { Cron } from 'croner';
import type { Collection, Db } from 'mongodb';
import type { EventHandler } from '../handlers/event-handler';
import { captureException } from '../lib/sentry';

const CHECK_INTERVAL_MS = 30_000; // 30 seconds

export interface Reminder {
  _id?: any;
  id?: number;
  channel_id: string;
  message: string;
  scheduled_time: number;
  created_at: number;
  status: 'pending' | 'sent' | 'cancelled';
}

export interface RecurringTask {
  _id?: any;
  id?: number;
  channel_id: string;
  message: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_run?: number;
  next_run: number;
  created_at: number;
}

export class SchedulerService {
  private db: Db;
  private remindersCollection: Collection<Reminder>;
  private recurringTasksCollection: Collection<RecurringTask>;
  private eventHandler: EventHandler;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(db: Db, eventHandler: EventHandler) {
    this.db = db;
    this.eventHandler = eventHandler;
    this.remindersCollection = db.collection<Reminder>('scheduler_reminders');
    this.recurringTasksCollection = db.collection<RecurringTask>('scheduler_recurring_tasks');
  }

  /**
   * Start the scheduler service
   * Begins checking for due reminders and tasks every 30 seconds
   */
  start(): void {
    console.log('📅 Scheduler service starting...');

    // Run immediately on start
    this.checkReminders();
    this.checkRecurringTasks();

    // Then run every 30 seconds
    this.checkInterval = setInterval(() => {
      this.checkReminders();
      this.checkRecurringTasks();
    }, CHECK_INTERVAL_MS);

    console.log('📅 Scheduler service started (checking every 30s)');
  }

  /**
   * Stop the scheduler service
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('📅 Scheduler service stopped');
  }

  /**
   * Check for pending reminders that are due
   */
  private async checkReminders(): Promise<void> {
    const now = Date.now();

    try {
      const pendingReminders = await this.remindersCollection
        .find({
          status: 'pending',
          scheduled_time: { $lte: now },
        })
        .sort({ scheduled_time: 1 })
        .toArray();

      for (const reminder of pendingReminders) {
        try {
          // Send the event through the EventHandler
          const result = await this.eventHandler.handleScheduledEvent({
            channelId: reminder.channel_id,
            message: reminder.message,
            eventType: 'reminder',
            wakeUpAgent: true,
            metadata: {
              source: 'scheduler',
              reminderId: reminder.id,
            },
          });

          if (result.success) {
            // Mark as sent
            await this.remindersCollection.updateOne(
              { id: reminder.id },
              { $set: { status: 'sent' } },
            );
            console.log(`✅ Sent reminder ${reminder.id} to channel ${reminder.channel_id}`);
          } else {
            console.error(`❌ Failed to send reminder ${reminder.id}: ${result.error}`);
          }
        } catch (error) {
          console.error(
            `❌ Error processing reminder ${reminder.id}:`,
            error instanceof Error ? error.message : String(error),
          );
          captureException(error, {
            context: 'scheduler-process-reminder',
            reminderId: reminder.id,
          });
        }
      }
    } catch (error) {
      console.error(
        '❌ Error checking reminders:',
        error instanceof Error ? error.message : String(error),
      );
      captureException(error, { context: 'scheduler-check-reminders' });
    }
  }

  /**
   * Check for recurring tasks that are due
   */
  private async checkRecurringTasks(): Promise<void> {
    const now = Date.now();

    try {
      const dueTasks = await this.recurringTasksCollection
        .find({
          enabled: true,
          next_run: { $lte: now },
        })
        .sort({ next_run: 1 })
        .toArray();

      for (const task of dueTasks) {
        try {
          // Send the event through the EventHandler
          const result = await this.eventHandler.handleScheduledEvent({
            channelId: task.channel_id,
            message: task.message,
            eventType: 'recurring_task',
            wakeUpAgent: true,
            metadata: {
              source: 'scheduler',
              taskId: task.id,
              cronExpression: task.cron_expression,
            },
          });

          if (result.success) {
            // Calculate next run time
            const nextRun = this.getNextRunTime(task.cron_expression, task.timezone);

            // Update last_run and next_run
            await this.recurringTasksCollection.updateOne(
              { id: task.id },
              { $set: { next_run: nextRun, last_run: now } },
            );

            console.log(
              `✅ Executed recurring task ${task.id}, next run: ${new Date(nextRun).toISOString()}`,
            );
          } else {
            console.error(`❌ Failed to execute recurring task ${task.id}: ${result.error}`);
          }
        } catch (error) {
          console.error(
            `❌ Error processing recurring task ${task.id}:`,
            error instanceof Error ? error.message : String(error),
          );
          captureException(error, { context: 'scheduler-process-recurring-task', taskId: task.id });
        }
      }
    } catch (error) {
      console.error(
        '❌ Error checking recurring tasks:',
        error instanceof Error ? error.message : String(error),
      );
      captureException(error, { context: 'scheduler-check-recurring-tasks' });
    }
  }

  /**
   * Calculate the next run time for a cron expression
   */
  private getNextRunTime(expression: string, timezone: string = 'Europe/Madrid'): number {
    try {
      const job = new Cron(expression, { timezone, paused: true });
      const next = job.nextRun();
      job.stop();

      if (!next) {
        throw new Error('Could not calculate next run time');
      }

      return next.getTime();
    } catch (error) {
      console.error(`Failed to calculate next run time for "${expression}":`, error);
      // Fallback: 1 hour from now
      return Date.now() + 60 * 60 * 1000;
    }
  }

  /**
   * Get statistics about pending reminders and tasks
   */
  async getStats(): Promise<{ pendingReminders: number; enabledTasks: number }> {
    try {
      const pendingReminders = await this.remindersCollection.countDocuments({ status: 'pending' });
      const enabledTasks = await this.recurringTasksCollection.countDocuments({ enabled: true });

      return {
        pendingReminders,
        enabledTasks,
      };
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return { pendingReminders: 0, enabledTasks: 0 };
    }
  }
}
