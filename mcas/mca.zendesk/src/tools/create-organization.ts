import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const createOrganization: ToolConfig = {
  description:
    'Create a new Zendesk organization. Returns the created organization. Not retryable. Params: name, domainNames?, tags?.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Organization name (must be unique).',
      },
      domainNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Email domains to auto-associate users (e.g. ["example.com"]).',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags to attach to the organization.',
      },
    },
    required: ['name'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { name, domainNames, tags } = args as {
      name: string;
      domainNames?: string[];
      tags?: string[];
    };

    const organization: Record<string, unknown> = { name };
    if (domainNames) organization.domain_names = domainNames;
    if (tags) organization.tags = tags;

    const result = (await zendeskRequest(context, '/organizations.json', {
      method: 'POST',
      body: { organization },
    })) as any;

    const o = result.organization;
    return {
      id: o.id,
      name: o.name,
      domainNames: o.domain_names ?? [],
      tags: o.tags ?? [],
      createdAt: o.created_at,
      url: o.url,
    };
  },
};
