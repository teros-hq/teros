import { factorialRequest } from '../lib';
import type { ToolDefinition } from '@teros/mca-sdk';

export const getDocument: ToolDefinition = {
  annotations: { readOnlyHint: true },
  description: 'Get detailed information about a specific document by ID.',
  parameters: {
    type: 'object',
    properties: {
      documentId: { type: 'number', description: 'The document ID' },
    },
    required: ['documentId'],
  },
  handler: async (args, context) => {
    return factorialRequest(context, `/documents/documents/${args.documentId}`);
  },
};
