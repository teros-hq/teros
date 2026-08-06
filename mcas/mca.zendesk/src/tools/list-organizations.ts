import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listOrganizations: ToolConfig = {
  description:
    'List Zendesk organizations. Returns curated rows { id, name, domainNames, tags, createdAt }. Params: limit (1-100, def 30), page.',
  parameters: {
    type: 'object',
    properties: {
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
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { limit, page } = args as {
      limit?: number;
      page?: number;
    };

    const result = (await zendeskRequest(context, '/organizations.json', {
      query: {
        per_page: Math.min(limit ?? 30, 100),
        page: page ?? 1,
      },
    })) as any;

    const organizations = (result.organizations ?? []).map((o: any) => ({
      id: o.id,
      name: o.name,
      domainNames: o.domain_names ?? [],
      tags: o.tags ?? [],
      createdAt: o.created_at,
      updatedAt: o.updated_at,
      url: o.url,
    }));

    return {
      organizations,
      total: organizations.length,
      page: page ?? 1,
      hasMore: result.next_page != null,
    };
  },
};
