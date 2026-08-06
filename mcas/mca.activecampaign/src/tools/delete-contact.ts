import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { wrap } from './_helpers.js';

interface Args {
  id: string;
}

export const deleteContact: ToolConfig<Args, unknown> = {
  description: 'Delete a contact by id. Permanent — no soft-delete in ActiveCampaign. Returns { id, deleted: true }.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact id' },
    },
    required: ['id'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    destructiveHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    if (!args.id?.trim()) throw new Error('id is required');
    await acRequest(context, `/contacts/${encodeURIComponent(args.id)}`, { method: 'DELETE' });
    return wrap({ id: args.id, deleted: true });
  },
};
