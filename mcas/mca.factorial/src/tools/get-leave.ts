import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const getLeave: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific time-off request by ID.',
  parameters: {
    type: 'object',
    properties: {
      leaveId: { type: 'number', description: 'The leave ID' },
    },
    required: ['leaveId'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, `/timeoff/leaves/${args.leaveId}`);
  },
};
