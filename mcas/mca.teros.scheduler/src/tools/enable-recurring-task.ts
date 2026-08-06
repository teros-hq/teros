import { z } from 'zod';
import { db, formatRecurringTask, getNextCronRun, SchedulerError } from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z.object({ taskId: z.number().int().positive() });

export const enableRecurringTask: SchedulerTool = {
  description: 'Enable (resume) a recurring task of the current user. Recomputes nextRun. Idempotent if already enabled.',
  parameters: {
    type: 'object',
    properties: { taskId: { type: 'number', description: 'Recurring task ID.' } },
    required: ['taskId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);

      const existing = await db.getRecurringTask(input.taskId, userId);
      if (!existing) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);

      const nextRun = getNextCronRun(existing.cron_expression, existing.timezone);
      const updated = await db.updateRecurringTask(input.taskId, userId, {
        enabled: true,
        next_run: nextRun,
      });
      if (!updated) {
        throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} disappeared during enable.`);
      }

      return structured({
        action: existing.enabled ? ('noop' as const) : ('enabled' as const),
        task: formatRecurringTask(updated),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
