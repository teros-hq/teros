import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const deleteContactGroup: ToolConfig = {
  description:
    'Delete a contact group. This does NOT delete the contacts in the group, only the group itself.',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact group resource name (e.g., 'contactGroups/abc123')",
      },
      deleteContacts: {
        type: 'boolean',
        description: 'If true, also delete the contacts in this group (default: false)',
      },
    },
    required: ['resourceName'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName, deleteContacts = false } = args as {
      resourceName: string;
      deleteContacts?: boolean;
    };

    return withAuthRetry(
      context,
      async () => {
        await clients.people.contactGroups.delete({
          resourceName,
          deleteContacts,
        });

        return {
          success: true,
          message: `Contact group ${resourceName} deleted successfully`,
          contactsDeleted: deleteContacts,
        };
      },
      'delete-contact-group',
    );
  },
};
