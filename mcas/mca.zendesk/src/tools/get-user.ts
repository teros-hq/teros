import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const getUser: ToolConfig = {
  description: 'Get a single Zendesk user by ID with full details.',
  parameters: {
    type: 'object',
    properties: {
      userId: {
        type: 'string',
        description: 'Zendesk user ID.',
      },
    },
    required: ['userId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { userId } = args as { userId: string };

    const result = (await zendeskRequest(context, `/users/${userId}.json`)) as any;
    const u = result.user;

    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      phone: u.phone,
      timeZone: u.time_zone,
      locale: u.locale,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      tags: u.tags ?? [],
      organizationId: u.organization_id,
      url: u.url,
    };
  },
};
