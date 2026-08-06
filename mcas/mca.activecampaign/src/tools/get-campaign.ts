import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { parseCampaign, wrap } from './_helpers.js';

interface Args {
  id: string;
  includeRaw?: boolean;
}

export const getCampaign: ToolConfig<Args, unknown> = {
  description:
    'Get a campaign by id. Returns { campaign: {id,name,subject,status,sendDate,fromName,fromEmail,totalRecipients,opens,clicks} }.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Campaign id' },
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
    const raw = (await acRequest(context, `/campaigns/${encodeURIComponent(args.id)}`)) as {
      campaign?: unknown;
    };
    return wrap({ campaign: parseCampaign(raw.campaign) }, args.includeRaw ? raw : undefined);
  },
};
