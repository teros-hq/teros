import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const rejectOvertime: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Reject an overtime request by ID.',
  parameters: {
    type: 'object',
    properties: {
      overtimeRequestId: { type: 'number', description: 'The overtime request ID to reject' },
    },
    required: ['overtimeRequestId'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, `/attendance/overtime_requests/${args.overtimeRequestId}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
};
