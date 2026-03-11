import { describeCronExpression } from '../cron-helper';
import { type RecurringTask, type Reminder, SchedulerDB } from '../db';
import { formatTime } from '../time-parser';

// Singleton database instance
export const db = new SchedulerDB();

// Helper to format reminder for response
export function formatReminder(r: Reminder) {
  return {
    id: r.id,
    message: r.message,
    scheduled_time: r.scheduled_time,
    scheduled_time_formatted: formatTime(r.scheduled_time),
    channel_id: r.channel_id,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
  };
}

// Helper to format recurring task for response
export function formatRecurringTask(t: RecurringTask) {
  return {
    id: t.id,
    message: t.message,
    cron_expression: t.cron_expression,
    cron_description: describeCronExpression(t.cron_expression),
    timezone: t.timezone,
    enabled: t.enabled === true || t.enabled === 1,
    next_run: t.next_run,
    next_run_formatted: formatTime(t.next_run),
    last_run: t.last_run,
    channel_id: t.channel_id,
    created_at: new Date(t.created_at).toISOString(),
  };
}

// Re-export types
export type { RecurringTask, Reminder } from '../db';
