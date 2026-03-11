import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const addContactsToGroup: ToolConfig = {
  description: 'Add one or more contacts to a contact group.',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact group resource name (e.g., 'contactGroups/abc123')",
      },
      contactResourceNames: {
        type: 'array',
        items: { type: 'string' },
        description: "Array of contact resource names to add (e.g., ['people/c123', 'people/c456'])",
      },
    },
    required: ['resourceName', 'contactResourceNames'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName, contactResourceNames } = args as {
      resourceName: string;
      contactResourceNames: string[];
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.people.contactGroups.members.modify({
          resourceName,
          requestBody: {
            resourceNamesToAdd: contactResourceNames,
          },
        });

        return {
          success: true,
          message: `Added ${contactResourceNames.length} contact(s) to group`,
          notFoundResourceNames: response.data.notFoundResourceNames || [],
          canNotAddResourceNames: response.data.canNotAddResourceNames || [],
        };
      },
      'add-contacts-to-group',
    );
  },
};
