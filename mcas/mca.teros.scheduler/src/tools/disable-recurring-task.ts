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

export const disableRecurringTask: SchedulerTool = {
  description: 'Disable (pause) a recurring task of the current user. Idempotent if already disabled.',
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

      const updated = await db.setRecurringEnabled(input.taskId, userId, false);
      if (!updated) {
        throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);
      }
      // Si ya estaba disabled, esto es noop. `updated.enabled` ya es false.
      // No tenemos manera de saber si era enabled o disabled antes sin re-read
      // — el doc post-update siempre tiene enabled:false. Reportamos 'disabled'
      // como acción uniforme (idempotency hint cubre el caso).
      return structured({
        action: 'disabled' as const,
        task: formatRecurringTask(updated),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
