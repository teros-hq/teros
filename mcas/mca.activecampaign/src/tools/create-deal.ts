import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseDeal, wrap } from './_helpers.js';

interface Args {
  title: string;
  value: number;
  currency?: string;
  contactId?: string;
  pipelineId: string;
  stageId: string;
  ownerId: string;
  description?: string;
  includeRaw?: boolean;
}

export const createDeal: ToolConfig<Args, unknown> = {
  description:
    'Create a deal. Required: title, value (in major units), pipelineId, stageId, ownerId. value is converted to cents internally. Returns { deal }.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      value: { type: 'number', description: 'Deal value in major units (e.g. 1500 for $1,500)' },
      currency: { type: 'string', description: 'ISO currency code, lowercase (default usd)' },
      contactId: { type: 'string' },
      pipelineId: { type: 'string', description: 'Pipeline (group) id' },
      stageId: { type: 'string' },
      ownerId: { type: 'string', description: 'User id of deal owner' },
      description: { type: 'string' },
      includeRaw: { type: 'boolean' },
    },
    required: ['title', 'value', 'pipelineId', 'stageId', 'ownerId'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.title?.trim()) throw new Error('title is required');
    if (!Number.isFinite(args.value)) throw new Error('value must be a finite number');
    if (args.value < 0) throw new Error('value must be a non-negative number');
    if (!args.pipelineId?.trim()) throw new Error('pipelineId is required');
    if (!args.stageId?.trim()) throw new Error('stageId is required');
    if (!args.ownerId?.trim()) throw new Error('ownerId is required');

    const cents = Math.round(args.value * 100);
    const body: Record<string, unknown> = {
      title: args.title.trim(),
      value: cents,
      currency: (args.currency ?? 'usd').toLowerCase(),
      group: args.pipelineId,
      stage: args.stageId,
      owner: args.ownerId,
    };
    if (args.contactId) body.contact = args.contactId;
    if (args.description) body.description = args.description;

    const raw = (await acRequest(context, '/deals', {
      method: 'POST',
      body: { deal: body },
    })) as { deal?: unknown };
    return wrap({ deal: parseDeal(raw.deal) }, args.includeRaw ? raw : undefined);
  },
};
