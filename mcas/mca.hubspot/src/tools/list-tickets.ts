import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatTicket } from '../lib';

export const listTickets: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot tickets with optional filters. Returns curated rows { id, subject, content, status, priority, category, pipeline, createdAt }. Params: limit (1-100, def 50), after, properties?',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Results per page. Min 1, max 100, default 50.' },
      after: { type: 'string', description: 'Pagination cursor from previous response.paging.next.after.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional ticket properties to include.',
      },
    },
  },
  handler: async (args, context) => {
    const { limit = 50, after, properties } = args as {
      limit?: number;
      after?: string;
      properties?: string[];
    };

    const defaultProps = ['subject', 'content', 'hs_ticket_priority', 'hs_pipeline_stage', 'hs_ticket_category', 'hs_pipeline', 'source_type', 'createdate', 'hs_lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const params: Record<string, any> = {
      limit: Math.min(Math.max(limit, 1), 100),
      properties: allProps.join(','),
    };
    if (after) params.after = after;

    const data = (await hubspotRequest(context, '/crm/v3/objects/tickets', { params })) as any;

    return {
      tickets: (data.results ?? []).map(formatTicket),
      total: data.results?.length ?? 0,
      hasMore: !!data.paging?.next?.after,
      nextCursor: data.paging?.next?.after ?? null,
    };
  },
};
