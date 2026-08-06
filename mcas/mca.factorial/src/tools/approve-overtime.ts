import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const approveOvertime: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Approve an overtime request by ID.',
  parameters: {
    type: 'object',
    properties: {
      overtimeRequestId: { type: 'number', description: 'The overtime request ID to approve' },
    },
    required: ['overtimeRequestId'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, `/attendance/overtime_requests/${args.overtimeRequestId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};
