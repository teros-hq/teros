import { z } from 'zod';
import { db, SchedulerError } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({
  taskId: z.number().int().positive(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const listExecutions: SchedulerTool = {
  description:
    'List execution history of a recurring task of the current user. Most recent first. Returns {items[], nextCursor?}.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'number', description: 'Recurring task ID.' },
      limit: { type: 'number', description: 'Max results (default 50, max 200).' },
      cursor: { type: 'string', description: 'Pagination cursor.' },
    },
    required: ['taskId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);
      // Verificar ownership de la task antes de exponer su historial.
      const task = await db.getRecurringTask(input.taskId, userId);
      if (!task) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);

      const page = await db.listExecutions({
        userId,
        taskId: input.taskId,
        limit: input.limit,
        cursor: input.cursor,
      });
      return structured({
        taskId: input.taskId,
        items: page.items.map((e) => ({
          ranAt: e.ran_at,
          ranAtIso: new Date(e.ran_at).toISOString(),
          status: e.status,
          error: e.error,
        })),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
