import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { buildPaginated, parseDeal, wrap } from './_helpers.js';

interface Args {
  search?: string;
  pipelineId?: string;
  stageId?: string;
  status?: 'open' | 'won' | 'lost';
  limit?: number;
  offset?: number;
  includeRaw?: boolean;
}

const STATUS_MAP: Record<string, number> = { open: 0, won: 1, lost: 2 };

export const listDeals: ToolConfig<Args, unknown> = {
  description:
    'List deals (CRM pipeline records). Returns { items[{id,title,value,currency,status,contact,pipeline,stage}], total, nextOffset }.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Search title/description' },
      pipelineId: { type: 'string', description: 'Filter by pipeline id' },
      stageId: { type: 'string', description: 'Filter by stage id' },
      status: { type: 'string', enum: ['open', 'won', 'lost'] },
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
    const numericStatus = args.status ? STATUS_MAP[args.status] : undefined;

    const searchParams: Record<string, string | number | undefined> = { limit, offset };
    if (args.search) searchParams['filters[search]'] = args.search;
    if (args.pipelineId) searchParams['filters[group]'] = args.pipelineId;
    if (args.stageId) searchParams['filters[stage]'] = args.stageId;
    if (numericStatus !== undefined) searchParams['filters[status]'] = numericStatus;

    const raw = (await acRequest(context, '/deals', { searchParams })) as {
      deals?: unknown[];
      meta?: unknown;
    };

    const items = (raw.deals ?? []).map(parseDeal);
    const data = buildPaginated(items, raw.meta, offset, limit);
    return wrap({ deals: data.items, total: data.total, nextOffset: data.nextOffset }, args.includeRaw ? raw : undefined);
  },
};
