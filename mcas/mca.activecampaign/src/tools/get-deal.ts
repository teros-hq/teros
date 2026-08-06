import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseDeal, wrap } from './_helpers.js';

interface Args {
  id: string;
  includeRaw?: boolean;
}

export const getDeal: ToolConfig<Args, unknown> = {
  description:
    'Get a deal by id. Returns { deal: {id,title,description,value,currency,status,contact,pipeline,stage,owner} }.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal id' },
      includeRaw: { type: 'boolean' },
    },
    required: ['id'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.id?.trim()) throw new Error('id is required');
    const raw = (await acRequest(context, `/deals/${encodeURIComponent(args.id)}`)) as {
      deal?: unknown;
    };
    return wrap({ deal: parseDeal(raw.deal) }, args.includeRaw ? raw : undefined);
  },
};
