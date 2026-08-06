import { z } from 'zod';
import {
  assertValidTimezone,
  db,
  formatReminder,
  parseTimeExpression,
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

const Schema = z
  .object({
    reminderId: z.number().int().positive(),
    time: z.string().min(1).optional(),
    message: z.string().min(1).max(4000).optional(),
    timezone: z.string().optional(),
    locale: z.enum(['en', 'es']).optional(),
    allowPast: z.boolean().optional(),
  })
  .refine((v) => v.time !== undefined || v.message !== undefined, {
    message: 'At least one of "time" or "message" must be provided.',
  });

export const updateReminder: SchedulerTool = {
  description:
    'Update a pending reminder of the current user. Provide time (re-parsed) or message (or both). Cancelled/sent reminders are not editable.',
  parameters: {
    type: 'object',
    properties: {
      reminderId: { type: 'number', description: 'ID of the reminder to update.' },
      time: { type: 'string', description: 'New time expression (natural or ISO).' },
      message: { type: 'string', description: 'New message text (max 4000 chars).' },
      timezone: { type: 'string', description: 'IANA timezone (default env).' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Parser locale.' },
      allowPast: { type: 'boolean', description: 'Allow scheduling in the past.' },
    },
    required: ['reminderId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);
      const timezone = input.timezone ?? resolveDefaultTimezone();
      assertValidTimezone(timezone);

      const patch: { message?: string; scheduled_time?: number } = {};
      if (input.message !== undefined) patch.message = input.message;
      if (input.time !== undefined) {
        const parsed = parseTimeExpression(input.time, {
          timezone,
          locale: input.locale,
          allowPast: input.allowPast,
        });
        patch.scheduled_time = parsed.timestamp;
      }

      // Atomic update con filter compuesto {id, user_id, status:'pending'}.
      // Si retorna null, distinguir entre NOT_FOUND y ALREADY_TERMINAL.
      const updated = await db.updateReminder(input.reminderId, userId, patch);
      if (!updated) {
        const current = await db.getReminder(input.reminderId, userId);
        if (!current) {
          throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`);
        }
        throw new SchedulerError(
          'ALREADY_TERMINAL',
          `Reminder is already ${current.status} and cannot be edited.`,
        );
      }

      return structured({
        action: 'updated' as const,
        changedFields: Object.keys(patch),
        reminder: formatReminder(updated, timezone),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
