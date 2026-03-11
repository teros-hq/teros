import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  getCredentials,
  getOrganization,
  type SentryProject,
  sentryRequest,
} from '../lib/index.js';

export const listProjects: ToolConfig = {
  description: 'List all projects in an organization',
  parameters: {
    type: 'object',
    properties: {
      organization: {
        type: 'string',
        description: "Organization slug (e.g., 'my-org'). Optional if configured in credentials.",
      },
    },
  },
  handler: async (args, context) => {
    const { authToken, organization: defaultOrg } = await getCredentials(context);
    const org = getOrganization(args.organization as string | undefined, defaultOrg);

    const projects = await sentryRequest<SentryProject[]>(
      authToken,
      `/organizations/${org}/projects/`,
    );

    return projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      id: p.id,
      platform: p.platform,
      dateCreated: p.dateCreated,
      firstEvent: p.firstEvent,
      hasAccess: p.hasAccess,
    }));
  },
};
