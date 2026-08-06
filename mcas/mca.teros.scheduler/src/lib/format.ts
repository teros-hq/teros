import { describeCronExpression } from './cron';
import type { RecurringTask, Reminder } from '../db';
import { formatNextRun } from './time';

// Re-export canonical scheduler status type from shared so consumers of
// `lib/format.ts` get the same values as the schema. Includes `'failed'`
// (added in TER-358 for dispatch-failure flagging by the executor).
export type { ReminderStatus } from '@teros/shared';
import type { ReminderStatus } from '@teros/shared';

export interface FormattedReminder {
  id: number;
  message: string;
  channelId: string;
  status: ReminderStatus;
  nextRunAt: number;
  nextRunIso: string;
  humanReadable: string;
  timezone: string;
  createdAt: string;
}

export interface FormattedRecurringTask {
  id: number;
  message: string;
  channelId: string;
  cronExpression: string;
  cronDescription: string;
  enabled: boolean;
  timezone: string;
  nextRunAt: number;
  nextRunIso: string;
  humanReadable: string;
  lastRunAt?: number;
  lastRunIso?: string;
  createdAt: string;
}

/**
 * Format a Reminder for output. The TZ used for `humanReadable` and emitted
 * back is — in priority order — the one stored in the document (if persisted
 * at create time), or the fallback passed by the caller (env default).
 * This guarantees that update/snooze/cancel preserve the original TZ instead
 * of overwriting with the env default (P2-1 fix, audit TER-186 2026-05-06).
 */
export function formatReminder(r: Reminder, fallbackTimezone: string): FormattedReminder {
  const nextRunAt = r.scheduled_time;
  const timezone = r.timezone ?? fallbackTimezone;
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
  };
}

export function formatRecurringTask(t: RecurringTask): FormattedRecurringTask {
  const enabled = t.enabled === true || (t.enabled as unknown as number) === 1;
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
  };
}
