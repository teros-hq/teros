import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const removeContactsFromGroup: ToolConfig = {
  description: 'Remove one or more contacts from a contact group.',
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
        description: "Array of contact resource names to remove (e.g., ['people/c123', 'people/c456'])",
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
            resourceNamesToRemove: contactResourceNames,
          },
        });

        return {
          success: true,
          message: `Removed ${contactResourceNames.length} contact(s) from group`,
          notFoundResourceNames: response.data.notFoundResourceNames || [],
        };
      },
      'remove-contacts-from-group',
    );
  },
};
