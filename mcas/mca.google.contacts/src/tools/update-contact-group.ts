import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const updateContactGroup: ToolConfig = {
  description: 'Update an existing contact group (rename it).',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact group resource name (e.g., 'contactGroups/abc123')",
      },
      name: {
        type: 'string',
        description: 'New name for the contact group',
      },
    },
    required: ['resourceName', 'name'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName, name } = args as {
      resourceName: string;
      name: string;
    };

    return withAuthRetry(
      context,
      async () => {
        // First get the current group to get the etag
        const currentGroup = await clients.people.contactGroups.get({
          resourceName,
          groupFields: 'name,metadata',
        });

        const response = await clients.people.contactGroups.update({
          resourceName,
          requestBody: {
            contactGroup: {
              name,
              etag: currentGroup.data.etag,
            },
            updateGroupFields: 'name',
          },
        });

        const group = response.data;

        return {
          success: true,
          resourceName: group.resourceName,
          name: group.name,
          formattedName: group.formattedName,
          groupType: group.groupType,
          metadata: group.metadata,
        };
      },
      'update-contact-group',
    );
  },
};
