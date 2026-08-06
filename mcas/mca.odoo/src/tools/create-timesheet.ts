import { odooCreate, odooRead } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const createTimesheet: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Create a new Odoo timesheet entry (account.analytic.line).',
  parameters: {
    type: 'object',
    properties: {
      projectId: { type: 'number', description: 'Project ID' },
      taskId: { type: 'number', description: 'Task ID (optional)' },
      employeeId: { type: 'number', description: 'Employee ID' },
      date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
      name: { type: 'string', description: 'Description of the work done' },
      hours: { type: 'number', description: 'Hours spent' },
    },
    required: ['projectId', 'employeeId', 'date', 'name', 'hours'],
  },
  handler: async (
    args: {
      projectId: number;
      taskId?: number;
      employeeId: number;
      date: string;
      name: string;
      hours: number;
    },
    context: ToolContext,
  ) => {
    const timesheetId = await odooCreate(context, 'account.analytic.line', {
      project_id: args.projectId,
      task_id: args.taskId,
      employee_id: args.employeeId,
      date: args.date,
      name: args.name,
      unit_amount: args.hours,
    });

    return odooRead(context, 'account.analytic.line', timesheetId, [
      'id',
      'date',
      'employee_id',
      'project_id',
      'task_id',
      'name',
      'unit_amount',
    ]);
  },
};
