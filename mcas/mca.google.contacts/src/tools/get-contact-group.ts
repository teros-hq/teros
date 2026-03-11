import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const getContactGroup: ToolConfig = {
  description:
    'Get detailed information about a specific contact group, including its members.',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact group resource name (e.g., 'contactGroups/abc123')",
      },
      maxMembers: {
        type: 'number',
        description: 'Maximum number of members to return (default: 100, max: 1000)',
      },
    },
    required: ['resourceName'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName, maxMembers = 100 } = args as {
      resourceName: string;
      maxMembers?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.people.contactGroups.get({
          resourceName,
          maxMembers: Math.min(maxMembers, 1000),
          groupFields: 'name,groupType,memberCount,metadata,clientData',
        });

        const group = response.data;

        return {
          resourceName: group.resourceName,
          name: group.name,
          formattedName: group.formattedName,
          groupType: group.groupType,
          memberCount: group.memberCount || 0,
          memberResourceNames: group.memberResourceNames || [],
          metadata: group.metadata,
        };
      },
      'get-contact-group',
    );
  },
};
