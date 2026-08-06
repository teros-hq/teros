import { z } from 'zod';
import { db, formatReminder, resolveDefaultTimezone } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  channelId: z.string().optional(),
  status: z.enum(['pending', 'sent', 'cancelled', 'failed']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  timezone: z.string().optional(),
});

export const listReminders: SchedulerTool = {
  description:
    'List reminders of the current user, paginated. Filter by channelId or status. Returns {items[], nextCursor?}.',
  parameters: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Filter by channel.' },
      status: {
        type: 'string',
        enum: ['pending', 'sent', 'cancelled', 'failed'],
        description: 'Filter by status (default: all).',
      },
      limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      cursor: { type: 'string', description: 'Pagination cursor from previous response.' },
      timezone: { type: 'string', description: 'IANA timezone for humanReadable (default env).' },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args ?? {});
      const timezone = input.timezone ?? resolveDefaultTimezone();
      const page = await db.listReminders({
        userId,
        channelId: input.channelId,
        status: input.status,
        limit: input.limit,
        cursor: input.cursor,
      });
      return structured({
        items: page.items.map((r) => formatReminder(r, timezone)),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
