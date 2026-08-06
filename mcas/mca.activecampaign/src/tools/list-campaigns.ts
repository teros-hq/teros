import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { buildPaginated, parseCampaign, wrap } from './_helpers.js';

interface Args {
  limit?: number;
  offset?: number;
  includeRaw?: boolean;
}

export const listCampaigns: ToolConfig<Args, unknown> = {
  description:
    'List email campaigns. Returns { items[{id,name,type,status,subject,sendDate,totalRecipients,totalOpens,uniqueOpens}], total, nextOffset }.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      offset: { type: 'number' },
      includeRaw: { type: 'boolean' },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const offset = Math.max(args.offset ?? 0, 0);
    const raw = (await acRequest(context, '/campaigns', {
      searchParams: { limit, offset, orders: 'sdate', direction: 'DESC' },
    })) as { campaigns?: unknown[]; meta?: unknown };

    const items = (raw.campaigns ?? []).map(parseCampaign);
    const data = buildPaginated(items, raw.meta, offset, limit);
    return wrap({ campaigns: data.items, total: data.total, nextOffset: data.nextOffset }, args.includeRaw ? raw : undefined);
  },
};
