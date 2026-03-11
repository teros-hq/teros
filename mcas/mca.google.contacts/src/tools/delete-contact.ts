import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const deleteContact: ToolConfig = {
  description: 'Delete a contact.',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact resource name (e.g., 'people/c123456789')",
      },
    },
    required: ['resourceName'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName } = args as { resourceName: string };

    return withAuthRetry(
      context,
      async () => {
        await clients.people.people.deleteContact({
          resourceName,
        });

        return {
          success: true,
          message: `Contact ${resourceName} deleted successfully`,
        };
      },
      'delete-contact',
    );
  },
};
