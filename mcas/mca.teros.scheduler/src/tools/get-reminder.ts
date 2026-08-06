import { z } from 'zod';
import { db, formatReminder, resolveDefaultTimezone, SchedulerError } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  reminderId: z.number().int().positive(),
  timezone: z.string().optional(),
});

export const getReminder: SchedulerTool = {
  description: 'Get a reminder by ID (must belong to current user). Returns full reminder with humanReadable next-run.',
  parameters: {
    type: 'object',
    properties: {
      reminderId: { type: 'number', description: 'Reminder ID.' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable (default env).' },
    },
    required: ['reminderId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);
      const reminder = await db.getReminder(input.reminderId, userId);
      if (!reminder) throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`);
      const timezone = input.timezone ?? resolveDefaultTimezone();
      return structured({ reminder: formatReminder(reminder, timezone) });
    } catch (error) {
      toToolError(error);
    }
  },
};
