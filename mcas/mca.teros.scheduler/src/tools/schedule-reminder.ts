import { z } from 'zod';
import {
  assertValidTimezone,
  db,
  formatReminder,
  parseTimeExpression,
  resolveDefaultTimezone,
} from '../lib';
import {
  assertChannelOwnership,
  assertValidChannelId,
  createChannelSubscription,
  optionalWorkspaceId,
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  time: z.string().min(1),
  message: z.string().min(1).max(4000),
  channelId: z.string().min(1),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'es']).optional(),
  allowPast: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const scheduleReminder: SchedulerTool = {
  description:
    'Schedule a one-shot reminder. time: natural ("in 2 hours", "tomorrow at 9am") or ISO 8601. timezone defaults to env. Returns the new reminder.',
  parameters: {
    type: 'object',
    properties: {
      time: { type: 'string', description: 'Natural ("in 2 hours", "tomorrow at 9am") or ISO 8601.' },
      message: { type: 'string', description: 'Message to deliver (max 4000 chars).' },
      channelId: { type: 'string', description: 'Channel that receives the wake event (must be owned by user).' },
      timezone: { type: 'string', description: 'IANA timezone (default: env MCA_DEFAULT_TIMEZONE).' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Parser locale (default: en).' },
      allowPast: { type: 'boolean', description: 'Allow scheduling in the past (default false).' },
      idempotencyKey: {
        type: 'string',
        description: 'Optional idempotency key. If a reminder with the same key+user already exists, returns it instead of creating a duplicate.',
      },
    },
    required: ['time', 'message', 'channelId'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const workspaceId = optionalWorkspaceId(context);
      const input = validateInput(Schema, args);
      assertValidChannelId(input.channelId);
      await assertChannelOwnership(context, userId, input.channelId);
      const timezone = input.timezone ?? resolveDefaultTimezone();
      assertValidTimezone(timezone);

      const parsed = parseTimeExpression(input.time, {
        timezone,
        locale: input.locale,
        allowPast: input.allowPast,
      });

      const reminder = await db.createReminder(
        userId,
        input.channelId,
        input.message,
        parsed.timestamp,
        timezone,
        workspaceId,
        input.idempotencyKey,
      );

      await createChannelSubscription(context, 'scheduler.reminder', input.channelId);

      return structured({
        action: 'created' as const,
        reminder: formatReminder(reminder, timezone),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
