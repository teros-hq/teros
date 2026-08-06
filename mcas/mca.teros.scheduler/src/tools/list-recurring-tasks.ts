import { z } from 'zod';
import { db, formatRecurringTask } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  channelId: z.string().optional(),
  enabled: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const listRecurringTasks: SchedulerTool = {
  description:
    'List recurring tasks of the current user, paginated. Filter by channelId or enabled. Returns {items[], nextCursor?}.',
  parameters: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Filter by channel.' },
      enabled: { type: 'boolean', description: 'Filter by enabled state.' },
      limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args ?? {});
      const page = await db.listRecurringTasks({
        userId,
        channelId: input.channelId,
        enabled: input.enabled,
        limit: input.limit,
        cursor: input.cursor,
      });
      return structured({
        items: page.items.map(formatRecurringTask),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
