import { z } from 'zod';
import { db, formatReminder, formatRecurringTask, resolveDefaultTimezone } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  channelId: z.string().optional(),
  days: z.number().int().min(1).max(90).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  timezone: z.string().optional(),
  include: z.enum(['reminders', 'recurring', 'both']).optional(),
});

export const listUpcoming: SchedulerTool = {
  description:
    'List upcoming reminders and recurring tasks of the current user within a window (default 7 days). include: reminders|recurring|both. Paginated.',
  parameters: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Filter by channel.' },
      days: { type: 'number', description: 'Window length in days (default 7, max 90).' },
      limit: { type: 'number', description: 'Max items per group (default 50, max 200).' },
      cursor: { type: 'string', description: 'Pagination cursor (applies to reminders only).' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable.' },
      include: { type: 'string', enum: ['reminders', 'recurring', 'both'], description: 'What to include (default both).' },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args ?? {});
      const timezone = input.timezone ?? resolveDefaultTimezone();
      const days = input.days ?? 7;
      const include = input.include ?? 'both';
      const now = Date.now();
      const horizon = now + days * 86_400_000;

      const remindersPage =
        include === 'recurring'
          ? { items: [], nextCursor: undefined as string | undefined }
          : await db.listReminders({
              userId,
              channelId: input.channelId,
              status: 'pending',
              scheduledAfter: now,
              scheduledBefore: horizon,
              limit: input.limit,
              cursor: input.cursor,
            });

      const tasksPage =
        include === 'reminders'
          ? { items: [], nextCursor: undefined as string | undefined }
          : await db.listRecurringTasks({
              userId,
              channelId: input.channelId,
              enabled: true,
              limit: input.limit,
            });

      return structured({
        windowDays: days,
        windowEndAt: horizon,
        windowEndIso: new Date(horizon).toISOString(),
        reminders: remindersPage.items.map((r) => formatReminder(r, timezone)),
        nextCursor: remindersPage.nextCursor,
        recurringTasks: tasksPage.items
          .filter((t) => t.next_run <= horizon)
          .map((t) => formatRecurringTask(t)),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
