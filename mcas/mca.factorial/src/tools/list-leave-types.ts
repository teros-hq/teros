import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listLeaveTypes: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all available leave types (vacation, sick leave, etc.).',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    return factorialRequest(context, '/timeoff/leave_types');
  },
};
