import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const getViewTickets: ToolConfig = {
  description:
    'Get tickets from a specific Zendesk view. Returns curated ticket rows. Params: viewId, limit (1-100, def 30), page.',
  parameters: {
    type: 'object',
    properties: {
      viewId: {
        type: 'string',
        description: 'Zendesk view ID.',
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
    required: ['viewId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { viewId, limit, page } = args as {
      viewId: string;
      limit?: number;
      page?: number;
    };

    const result = (await zendeskRequest(
      context,
      `/views/${viewId}/tickets.json`,
      {
        query: {
          per_page: Math.min(limit ?? 30, 100),
          page: page ?? 1,
        },
      },
    )) as any;

    const tickets = (result.tickets ?? []).map((t: any) => ({
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
    }));

    return {
      viewId,
      tickets,
      total: tickets.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
