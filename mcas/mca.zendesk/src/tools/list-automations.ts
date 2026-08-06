import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listAutomations: ToolConfig = {
  description:
    'List Zendesk automations (time-based business rules). Read-only for agents. Returns curated rows { id, title, active, position, createdAt }.',
  parameters: {
    type: 'object',
    properties: {
      active: {
        type: 'boolean',
        description: 'Filter by active status.',
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
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { active, limit, page } = args as {
      active?: boolean;
      limit?: number;
      page?: number;
    };

    const query: Record<string, string | number | undefined> = {
      per_page: Math.min(limit ?? 30, 100),
      page: page ?? 1,
    };
    if (active !== undefined) query.active = String(active);

    const result = (await zendeskRequest(context, '/automations.json', {
      query,
    })) as any;

    const automations = (result.automations ?? []).map((a: any) => ({
      id: a.id,
      title: a.title,
      active: a.active,
      position: a.position,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      url: a.url,
    }));

    return {
      automations,
      total: automations.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
