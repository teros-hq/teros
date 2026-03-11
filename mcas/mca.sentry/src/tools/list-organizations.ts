import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, type SentryOrganization, sentryRequest } from '../lib/index.js';

export const listOrganizations: ToolConfig = {
  description: 'List all organizations the authenticated user has access to',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const { authToken } = await getCredentials(context);

    const orgs = await sentryRequest<SentryOrganization[]>(authToken, '/organizations/');

    return orgs.map((org) => ({
      slug: org.slug,
      name: org.name,
      id: org.id,
      dateCreated: org.dateCreated,
    }));
  },
};
