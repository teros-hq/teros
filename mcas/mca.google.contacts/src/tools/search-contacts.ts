import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

const READ_MASK = 'names,emailAddresses,phoneNumbers,organizations,photos';

export const searchContacts: ToolConfig = {
  description: 'Search for contacts by query.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (name, email, phone, etc.)',
      },
      pageSize: {
        type: 'number',
        description: 'Number of results per page (default: 30, max: 30)',
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { query, pageSize = 30 } = args as {
      query: string;
      pageSize?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.people.people.searchContacts({
          query,
          pageSize: Math.min(pageSize, 30),
          readMask: READ_MASK,
        });

        const contacts = (response.data.results || []).map((result) => {
          const person = result.person;
          return {
            resourceName: person?.resourceName,
            name: person?.names?.[0]?.displayName,
            emails: person?.emailAddresses?.map((e) => e.value),
            phones: person?.phoneNumbers?.map((p) => p.value),
            organization: person?.organizations?.[0]?.name,
            photo: person?.photos?.[0]?.url,
          };
        });

        return { contacts };
      },
      'search-contacts',
    );
  },
};
