import { odooCreate, odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createLeave: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new Odoo time-off request (hr.leave).',
  parameters: {
    type: 'object',
    properties: {
      employeeId: { type: 'number', description: 'Employee ID' },
      holidayStatusId: { type: 'number', description: 'Leave type ID' },
      dateFrom: { type: 'string', description: 'Start date/time (ISO 8601)' },
      dateTo: { type: 'string', description: 'End date/time (ISO 8601)' },
      name: { type: 'string', description: 'Reason / description' },
    },
    required: ['employeeId', 'holidayStatusId', 'dateFrom', 'dateTo'],
  },
  handler: async (
    args: {
      employeeId: number;
      holidayStatusId: number;
      dateFrom: string;
      dateTo: string;
      name?: string;
    },
    context: ToolContext,
  ) => {
    const leaveId = await odooCreate(context, 'hr.leave', {
      employee_id: args.employeeId,
      holiday_status_id: args.holidayStatusId,
      date_from: args.dateFrom,
      date_to: args.dateTo,
      name: args.name,
    });

    return odooRead(context, 'hr.leave', leaveId, [
      'id',
      'employee_id',
      'holiday_status_id',
      'date_from',
      'date_to',
      'state',
    ]);
  },
};
