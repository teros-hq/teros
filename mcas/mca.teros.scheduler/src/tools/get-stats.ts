import { z } from 'zod';
import { db, formatNextRun, resolveDefaultTimezone } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  timezone: z.string().optional(),
});

export const getStats: SchedulerTool = {
  description:
    'Live counters for the current user: active reminders, active recurring tasks, and next scheduled run timestamp.',
  parameters: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA timezone for nextScheduledHumanReadable (default env).' },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args ?? {});
      const timezone = input.timezone ?? resolveDefaultTimezone();

      if (!db.isConnected()) {
        await db.connect();
      }

      const [activeReminders, activeRecurring, nextScheduledAt] = await Promise.all([
        db.countActiveReminders(userId),
        db.countActiveRecurringTasks(userId),
        db.getNextScheduledTimestamp(userId),
      ]);

      return structured({
        active: { reminders: activeReminders, recurringTasks: activeRecurring },
        nextScheduledAt,
        nextScheduledIso: nextScheduledAt ? new Date(nextScheduledAt).toISOString() : null,
        nextScheduledHumanReadable: nextScheduledAt ? formatNextRun(nextScheduledAt, timezone) : null,
        timezone,
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
