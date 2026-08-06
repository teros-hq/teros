import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const getEmployee: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific employee by ID.',
  parameters: {
    type: 'object',
    properties: {
      employeeId: { type: 'number', description: 'The employee ID' },
    },
    required: ['employeeId'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, `/employees/employees/${args.employeeId}`);
  },
};
