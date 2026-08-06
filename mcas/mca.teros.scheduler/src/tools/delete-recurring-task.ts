import { z } from 'zod';
import { db, formatRecurringTask, SchedulerError } from '../lib';
import {
  cleanupChannelSubscriptions,
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({ taskId: z.number().int().positive() });

export const deleteRecurringTask: SchedulerTool = {
  description:
    'Permanently delete a recurring task of the current user. Cleans up channel subscription if last one for the channel.',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'number', description: 'Recurring task ID.' } },
    required: ['taskId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', destructiveHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);

      // Atomic deleteOne con filter compuesto. Retorna el doc anterior si
      // existía y era del user. null → NOT_FOUND.
      const deleted = await db.deleteRecurringTask(input.taskId, userId);
      if (!deleted) {
        throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);
      }

      // Cleanup subscription si era el último recurring task del user en ese channel.
      const remaining = (
        await db.listRecurringTasks({ userId, channelId: deleted.channel_id, limit: 1 })
      ).items;
      if (remaining.length === 0) {
        await cleanupChannelSubscriptions(context, deleted.channel_id, ['scheduler.recurring_task']);
      }

      return structured({
        action: 'deleted' as const,
        task: formatRecurringTask(deleted),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
