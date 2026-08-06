import { z } from 'zod';
import {
  db,
  formatReminder,
  parseDelayExpression,
  resolveDefaultTimezone,
  SchedulerError,
} from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  reminderId: z.number().int().positive(),
  delay: z.string().min(1),
  timezone: z.string().optional(),
});

export const snoozeReminder: SchedulerTool = {
  description:
    'Postpone a pending reminder of the current user by a delay (e.g. "30m", "2h", "1d"). Adds delay on top of current time.',
  parameters: {
    type: 'object',
    properties: {
      reminderId: { type: 'number', description: 'ID of the reminder to snooze.' },
      delay: { type: 'string', description: 'Delay expression (e.g. "30m", "2h", "1d").' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable (default env).' },
    },
    required: ['reminderId', 'delay'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);

      const delayMs = parseDelayExpression(input.delay);
      const newScheduled = Date.now() + delayMs;

      const updated = await db.updateReminder(input.reminderId, userId, { scheduled_time: newScheduled });
      if (!updated) {
        const current = await db.getReminder(input.reminderId, userId);
        if (!current) {
          throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`);
        }
        throw new SchedulerError('ALREADY_TERMINAL', `Reminder is already ${current.status}.`);
      }

      const timezone = input.timezone ?? resolveDefaultTimezone();
      return structured({
        action: 'snoozed' as const,
        delayMs,
        // `updated` is the post-update doc; expose the new scheduled time and
        // the delta from now for the renderer.
        reminder: formatReminder(updated, timezone),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
