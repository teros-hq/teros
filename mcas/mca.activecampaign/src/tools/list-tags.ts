import type { ToolConfig } from '@teros/mca-sdk';
import { acRequest } from '../lib/index.js';
import { buildPaginated, parseTag, wrap } from './_helpers.js';

interface Args {
  search?: string;
  limit?: number;
  offset?: number;
  includeRaw?: boolean;
}

export const listTags: ToolConfig<Args, unknown> = {
  description: 'List tags. Returns { items[{id,name,description,tagType}], total, nextOffset }.',
  parameters: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Substring match on tag name' },
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
    const raw = (await acRequest(context, '/tags', {
      searchParams: { limit, offset, search: args.search },
    })) as { tags?: unknown[]; meta?: unknown };

    const items = (raw.tags ?? []).map(parseTag);
    const data = buildPaginated(items, raw.meta, offset, limit);
    return wrap({ tags: data.items, total: data.total, nextOffset: data.nextOffset }, args.includeRaw ? raw : undefined);
  },
};
