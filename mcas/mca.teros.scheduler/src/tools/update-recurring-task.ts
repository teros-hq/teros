import { z } from 'zod';
import {
  assertValidCron,
  assertValidTimezone,
  db,
  formatRecurringTask,
  getNextCronRun,
  SchedulerError,
} from '../lib';
import {
  requireUserId,
  structured,
  type SchedulerTool,
  toToolError,
  validateInput,
} from './_shared';

const Schema = z
  .object({
    taskId: z.number().int().positive(),
    cronExpression: z.string().min(1).optional(),
    message: z.string().min(1).max(4000).optional(),
    timezone: z.string().optional(),
  })
  .refine(
    (v) => v.cronExpression !== undefined || v.message !== undefined || v.timezone !== undefined,
    { message: 'Provide at least one of cronExpression, message or timezone.' },
  );

export const updateRecurringTask: SchedulerTool = {
  description:
    'Update a recurring task of the current user. Provide cronExpression (re-validates and recomputes nextRun), message, or timezone.',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'number', description: 'ID of the recurring task.' },
      cronExpression: { type: 'string', description: 'New cron expression (5 fields).' },
      message: { type: 'string', description: 'New message text (max 4000 chars).' },
      timezone: { type: 'string', description: 'New IANA timezone.' },
    },
    required: ['taskId'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable', idempotentHint: true },
  handler: async (args, context) => {
    try {
      const userId = requireUserId(context);
      const input = validateInput(Schema, args);

      // Lookup primero para obtener el shape actual (necesario para recompute
      // de next_run si cambia cron/tz). El ownership ya queda enforcado en
      // este lookup.
      const existing = await db.getRecurringTask(input.taskId, userId);
      if (!existing) throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} not found.`);

      const patch: { cron_expression?: string; message?: string; timezone?: string; next_run?: number } = {};
      const newCron = input.cronExpression ?? existing.cron_expression;
      const newTz = input.timezone ?? existing.timezone;

      if (input.cronExpression !== undefined) {
        assertValidCron(input.cronExpression);
        patch.cron_expression = input.cronExpression;
      }
      if (input.timezone !== undefined) {
        assertValidTimezone(input.timezone);
        patch.timezone = input.timezone;
      }
      if (input.message !== undefined) patch.message = input.message;
      if (input.cronExpression !== undefined || input.timezone !== undefined) {
        patch.next_run = getNextCronRun(newCron, newTz);
      }

      const updated = await db.updateRecurringTask(input.taskId, userId, patch);
      if (!updated) {
        // Race: existía cuando hicimos getRecurringTask pero ya no, o el doc
        // ya fue eliminado por otro proceso. NOT_FOUND es el código correcto.
        throw new SchedulerError('NOT_FOUND', `Recurring task ${input.taskId} disappeared during update.`);
      }

      return structured({
        action: 'updated' as const,
        changedFields: Object.keys(patch),
        task: formatRecurringTask(updated),
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
