import { z } from 'zod';
import { db, formatRecurringTask, SchedulerError } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({ taskId: z.number().int().positive() });

export const getRecurringTask: SchedulerTool = {
  description: 'Get a recurring task by ID (must belong to current user). Returns full task with cronDescription and humanReadable next-run.',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'number', description: 'Recurring task ID.' } },
    required: ['taskId'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);
      const task = await db.getRecurringTask(input.taskId, userId);
      if (!task) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);
      return structured({ task: formatRecurringTask(task) });
    } catch (error) {
      toToolError(error);
    }
  },
};
