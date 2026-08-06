import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listGroups: ToolConfig = {
  description:
    'List Zendesk groups (ticket assignment groups). Returns curated rows { id, name, default, createdAt }.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (_args, context) => {
    const result = (await zendeskRequest(context, '/groups.json')) as any;

    const groups = (result.groups ?? []).map((g: any) => ({
      id: g.id,
      name: g.name,
      default: g.default,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      url: g.url,
    }));

    return {
      groups,
      total: groups.length,
    };
  },
};
