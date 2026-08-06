import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listTeams: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all teams in the company.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    return factorialRequest(context, '/teams/teams');
  },
};
