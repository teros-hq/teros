import type { ToolConfig } from '@teros/mca-sdk';
import { buildBrandTemplateShape, canvaRequest } from '../lib';
import { BRAND_TEMPLATE_COMPACT_FIELDS } from './_fields';
import { resolveFieldsList, sanitizeLimit, wrapCanvaCall } from './utils';

export const listBrandTemplates: ToolConfig = {
  description:
    'List brand templates the user can access (requires Canva Enterprise). Returns curated rows with thumbnail URL. Params: query?, ownership?, limit (1-100, def 25), continuation?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search term to filter templates.' },
      ownership: { type: 'string', description: 'Filter by ownership.' },
      limit: { type: 'number', description: 'Max results. Min 1, max 100, default 25.' },
      continuation: { type: 'string', description: 'Pagination token.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva response. Default false.' },
    },
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { query, ownership, limit, continuation, fields, includeRaw } = args as {
      query?: string;
      ownership?: string;
      limit?: number;
      continuation?: string;
      fields?: string[];
      includeRaw?: boolean;
    };

    const params = new URLSearchParams();
    if (query) params.append('query', query);
    if (ownership) params.append('ownership', ownership);
    params.append('limit', String(sanitizeLimit(limit, { max: 100, default: 25 })));
    if (continuation) params.append('continuation', continuation);

    const raw: any = await wrapCanvaCall(() =>
      canvaRequest(context, `/brand-templates?${params.toString()}`),
    );
    const items: any[] = Array.isArray(raw?.items) ? raw.items : [];
    const shaped = items.map((it) => buildBrandTemplateShape(it));
    const templates = resolveFieldsList(shaped as any[], items, {
      includeRaw,
      fields,
      defaultFields: BRAND_TEMPLATE_COMPACT_FIELDS,
    });

    return {
      templates,
      total: templates.length,
      hasMore: !!raw?.continuation,
      nextCursor: raw?.continuation ?? null,
    };
  },
};
