import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listLocations: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all company work locations and offices.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    return factorialRequest(context, '/locations/locations');
  },
};
