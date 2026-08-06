import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const listLegalEntities: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'List all company legal entities.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    return factorialRequest(context, '/companies/legal_entities');
  },
};
