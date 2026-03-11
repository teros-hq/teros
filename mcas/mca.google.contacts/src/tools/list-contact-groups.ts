import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listContactGroups: ToolConfig = {
  description:
    'List all contact groups (labels) from Google Contacts. Returns group name, member count, and type.',
  parameters: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Maximum number of groups to return (default: 100, max: 1000)',
      },
      pageToken: {
        type: 'string',
        description: 'Token for pagination (from previous response)',
      },
    },
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { pageSize = 100, pageToken } = args as {
      pageSize?: number;
      pageToken?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.people.contactGroups.list({
          pageSize: Math.min(pageSize, 1000),
          pageToken,
          groupFields: 'name,groupType,memberCount,metadata',
        });

        const groups = (response.data.contactGroups || []).map((group) => ({
          resourceName: group.resourceName,
          name: group.name,
          formattedName: group.formattedName,
          groupType: group.groupType,
          memberCount: group.memberCount || 0,
          metadata: group.metadata,
        }));

        return {
          groups,
          totalItems: response.data.totalItems,
          nextPageToken: response.data.nextPageToken,
        };
      },
      'list-contact-groups',
    );
  },
};
