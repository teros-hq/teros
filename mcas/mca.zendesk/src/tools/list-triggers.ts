import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listTriggers: ToolConfig = {
  description:
    'List Zendesk triggers (business rules that fire on ticket events). Read-only for agents. Returns curated rows { id, title, active, position, createdAt }.',
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

    const result = (await zendeskRequest(context, '/triggers.json', {
      query,
    })) as any;

    const triggers = (result.triggers ?? []).map((t: any) => ({
      id: t.id,
      title: t.title,
      active: t.active,
      position: t.position,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      url: t.url,
    }));

    return {
      triggers,
      total: triggers.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
