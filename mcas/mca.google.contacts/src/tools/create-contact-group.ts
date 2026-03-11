import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createContactGroup: ToolConfig = {
  description: 'Create a new contact group (label) in Google Contacts.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the contact group (must be unique)',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { name } = args as { name: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.people.contactGroups.create({
          requestBody: {
            contactGroup: {
              name,
            },
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
      'create-contact-group',
    );
  },
};
