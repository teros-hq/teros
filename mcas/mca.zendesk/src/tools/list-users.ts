import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listUsers: ToolConfig = {
  description:
    'List Zendesk users with optional filters. Returns curated rows { id, name, email, role, active, createdAt }. Params: role?, query?, limit (1-100, def 30), page.',
  parameters: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['end-user', 'agent', 'admin'],
        description: 'Filter by user role.',
      },
      query: {
        type: 'string',
        description: 'Search query for user name or email.',
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
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { role, query, limit, page } = args as {
      role?: string;
      query?: string;
      limit?: number;
      page?: number;
    };

    const perPage = Math.min(limit ?? 30, 100);
    const pageNum = page ?? 1;

    let result: any;

    if (query) {
      // Use search API when query is provided
      result = (await zendeskRequest(context, '/users/search.json', {
        query: {
          query,
          per_page: perPage,
          page: pageNum,
        },
      })) as any;
    } else if (role) {
      result = (await zendeskRequest(context, `/users.json`, {
        query: {
          role,
          per_page: perPage,
          page: pageNum,
        },
      })) as any;
    } else {
      result = (await zendeskRequest(context, '/users.json', {
        query: { per_page: perPage, page: pageNum },
      })) as any;
    }

    const users = (result.users ?? []).map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      tags: u.tags ?? [],
      organizationId: u.organization_id,
      url: u.url,
    }));

    return {
      users,
      total: users.length,
      page: pageNum,
      hasMore: result.next_page != null,
    };
  },
};
