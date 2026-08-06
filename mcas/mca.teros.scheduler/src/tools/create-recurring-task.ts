import { z } from 'zod';
import {
  assertValidCron,
  assertValidTimezone,
  db,
  formatRecurringTask,
  getNextCronRun,
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
  cronExpression: z.string().min(1),
  message: z.string().min(1).max(4000),
  channelId: z.string().min(1),
  timezone: z.string().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

export const createRecurringTask: SchedulerTool = {
  description:
    'Create a recurring task using a 5-field cron expression. Examples: "0 9 * * *", "*/15 * * * *", "0 10-22 * * 1-5". timezone defaults to env.',
  parameters: {
    type: 'object',
    properties: {
      cronExpression: { type: 'string', description: 'Cron 5 fields: "min hour day month weekday".' },
      message: { type: 'string', description: 'Message delivered on each run (max 4000 chars).' },
      channelId: { type: 'string', description: 'Channel that receives the wake event (must be owned by user).' },
      timezone: { type: 'string', description: 'IANA timezone (default: env MCA_DEFAULT_TIMEZONE).' },
      idempotencyKey: {
        type: 'string',
        description: 'Optional idempotency key. If a recurring task with the same key+user already exists, returns it instead of creating a duplicate.',
      },
    },
    required: ['cronExpression', 'message', 'channelId'],
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
      assertValidCron(input.cronExpression);

      const nextRun = getNextCronRun(input.cronExpression, timezone);
      const task = await db.createRecurringTask(
        userId,
        input.channelId,
        input.message,
        input.cronExpression,
        nextRun,
        timezone,
        workspaceId,
        input.idempotencyKey,
      );

      await createChannelSubscription(context, 'scheduler.recurring_task', input.channelId);

      return structured({
        action: 'created' as const,
        task: formatRecurringTask(task),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
