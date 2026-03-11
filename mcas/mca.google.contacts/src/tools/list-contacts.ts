import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

const PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,addresses,biographies,photos';

export const listContacts: ToolConfig = {
  description:
    'List contacts from Google Contacts. Returns name, email, phone numbers. Supports pagination.',
  parameters: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Number of contacts per page (default: 100, max: 1000)',
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
        const response = await clients.people.people.connections.list({
          resourceName: 'people/me',
          pageSize: Math.min(pageSize, 1000),
          pageToken,
          personFields: PERSON_FIELDS,
        });

        const contacts = (response.data.connections || []).map((person) => ({
          resourceName: person.resourceName,
          name: person.names?.[0]?.displayName,
          givenName: person.names?.[0]?.givenName,
          familyName: person.names?.[0]?.familyName,
          emails: person.emailAddresses?.map((e) => e.value),
          phones: person.phoneNumbers?.map((p) => ({ value: p.value, type: p.type })),
          organization: person.organizations?.[0]?.name,
          title: person.organizations?.[0]?.title,
          photo: person.photos?.[0]?.url,
        }));

        return {
          contacts,
          totalItems: response.data.totalItems,
          nextPageToken: response.data.nextPageToken,
        };
      },
      'list-contacts',
    );
  },
};
