import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const searchTickets: ToolConfig = {
  description:
    'Search Zendesk tickets using Zendesk Search API. Supports query syntax (e.g. "status:open type:ticket", "assignee:me", "tags:urgent"). Returns curated results. Params: query, limit (1-100, def 30), page.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Zendesk search query string.',
      },
      limit: {
        type: 'number',
        description: 'Results per page. Min 1, max 100, default 30.',
      },
      page: {
        type: 'number',
        description: 'Page number for pagination. Default 1.',
      },
    },
    required: ['query'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { query, limit, page } = args as {
      query: string;
      limit?: number;
      page?: number;
    };

    const result = (await zendeskRequest(context, '/search.json', {
      query: {
        query,
        per_page: Math.min(limit ?? 30, 100),
        page: page ?? 1,
      },
    })) as any;

    const results = (result.results ?? []).filter((r: any) => r.result_type === 'ticket');

    return {
      tickets: results.map((t: any) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        type: t.type,
        requesterId: t.requester_id,
        assigneeId: t.assignee_id,
        organizationId: t.organization_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        tags: t.tags ?? [],
        url: t.url,
      })),
      total: result.count ?? results.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
