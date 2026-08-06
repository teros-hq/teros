import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listViews: ToolConfig = {
  description:
    'List Zendesk views (ticket filters). Returns curated rows { id, title, active, position, createdAt }.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (_args, context) => {
    const result = (await zendeskRequest(context, '/views.json')) as any;

    const views = (result.views ?? []).map((v: any) => ({
      id: v.id,
      title: v.title,
      active: v.active,
      position: v.position,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
      url: v.url,
    }));

    return {
      views,
      total: views.length,
    };
  },
};
