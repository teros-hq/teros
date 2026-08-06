import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const getOrganization: ToolConfig = {
  description:
    'Get a single Zendesk organization by ID with full details including domain names and tags.',
  parameters: {
    type: 'object',
    properties: {
      organizationId: {
        type: 'string',
        description: 'Zendesk organization ID.',
      },
    },
    required: ['organizationId'],
  },
  annotations: { readOnlyHint: true, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { organizationId } = args as { organizationId: string };

    const result = (await zendeskRequest(
      context,
      `/organizations/${organizationId}.json`,
    )) as any;
    const o = result.organization;

    return {
      id: o.id,
      name: o.name,
      domainNames: o.domain_names ?? [],
      tags: o.tags ?? [],
      createdAt: o.created_at,
      updatedAt: o.updated_at,
      url: o.url,
    };
  },
};
