import { z } from 'zod';
import { db, formatReminder, resolveDefaultTimezone, SchedulerError } from '../lib';
import {
  cleanupChannelSubscriptions,
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

export const cancelReminder: SchedulerTool = {
  description:
    'Cancel a pending reminder of the current user. Idempotent (returns noop if already cancelled). Cleans up channel subscription if last one.',
  parameters: {
    type: 'object',
    properties: {
      reminderId: { type: 'number', description: 'ID of the reminder to cancel.' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable (default env).' },
    },
    required: ['reminderId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);
      const timezone = input.timezone ?? resolveDefaultTimezone();

      // Atomic compare-and-set. Si retorna null:
      //   - el reminder no existe / no es del user → NOT_FOUND
      //   - existe pero ya no está pending → noop con el shape actual
      const cancelled = await db.cancelReminder(input.reminderId, userId);
      if (!cancelled) {
        const current = await db.getReminder(input.reminderId, userId);
        if (!current) {
          throw new SchedulerError('NOT_FOUND', `Reminder ${input.reminderId} not found.`);
        }
        return structured({
          action: 'noop' as const,
          reminder: formatReminder(current, timezone),
          reason: `Already ${current.status}.`,
        });
      }

      // Cleanup de la subscription si ya no quedan reminders pending en el channel.
      const channelStillUsed = (
        await db.listReminders({
          userId,
          channelId: cancelled.channel_id,
          status: 'pending',
          limit: 1,
        })
      ).items.length > 0;
      if (!channelStillUsed) {
        await cleanupChannelSubscriptions(context, cancelled.channel_id, ['scheduler.reminder']);
      }

      return structured({
        action: 'cancelled' as const,
        reminder: formatReminder(cancelled, timezone),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
