import { odooCallMethod } from '../lib/odoo-client.js';
import type { ToolContext, ToolDefinition } from '@teros/mca-sdk';

export const callMethod: ToolDefinition = {
  annotations: { readOnlyHint: false },
  description: 'Call any public method on an Odoo model.',
  parameters: {
    type: 'object',
    properties: {
      model: { type: 'string', description: 'Odoo model technical name' },
      method: { type: 'string', description: 'Method name to call' },
      args: {
        type: 'array',
        description: 'Positional arguments passed to the method',
        items: {},
      },
      kwargs: {
        type: 'object',
        description: 'Keyword arguments passed to the method',
        additionalProperties: true,
      },
    },
    required: ['model', 'method'],
  },
  handler: async (
    args: {
      model: string;
      method: string;
      args?: unknown[];
      kwargs?: Record<string, unknown>;
    },
    context: ToolContext,
  ) => {
    return odooCallMethod(
      context,
      args.model,
      args.method,
      args.args ?? [],
      args.kwargs ?? {},
    );
  },
};
