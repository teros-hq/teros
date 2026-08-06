import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const createLeave: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new time-off request (vacation, sick leave, etc.).',
  parameters: {
    type: 'object',
    properties: {
      employeeId: { type: 'number', description: 'The employee ID requesting the leave' },
      leaveTypeId: { type: 'number', description: 'The leave type ID' },
      startOn: { type: 'string', description: 'Start date in ISO format (YYYY-MM-DD)' },
      finishOn: { type: 'string', description: 'End date in ISO format (YYYY-MM-DD)' },
      halfDayStart: { type: 'boolean', description: 'Whether the start day is a half day' },
      halfDayFinish: { type: 'boolean', description: 'Whether the end day is a half day' },
      comment: { type: 'string', description: 'Optional comment or reason' },
    },
    required: ['employeeId', 'leaveTypeId', 'startOn', 'finishOn'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, '/timeoff/leaves', {
      method: 'POST',
      body: JSON.stringify({
        employee_id: args.employeeId,
        leave_type_id: args.leaveTypeId,
        start_on: args.startOn,
        finish_on: args.finishOn,
        half_day_start: args.halfDayStart,
        half_day_finish: args.halfDayFinish,
        comment: args.comment,
      }),
    });
  },
};
