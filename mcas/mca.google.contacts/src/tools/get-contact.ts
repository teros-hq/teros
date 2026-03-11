import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

const PERSON_FIELDS =
  'names,emailAddresses,phoneNumbers,organizations,addresses,biographies,photos,birthdays,urls';

export const getContact: ToolConfig = {
  description: 'Get a specific contact by resource name.',
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
        const response = await clients.people.people.get({
          resourceName,
          personFields: PERSON_FIELDS,
        });

        const person = response.data;

        return {
          resourceName: person.resourceName,
          etag: person.etag,
          name: person.names?.[0]?.displayName,
          givenName: person.names?.[0]?.givenName,
          familyName: person.names?.[0]?.familyName,
          emails: person.emailAddresses?.map((e) => ({ value: e.value, type: e.type })),
          phones: person.phoneNumbers?.map((p) => ({ value: p.value, type: p.type })),
          organizations: person.organizations?.map((o) => ({ name: o.name, title: o.title })),
          addresses: person.addresses?.map((a) => ({
            formattedValue: a.formattedValue,
            type: a.type,
            city: a.city,
            country: a.country,
          })),
          biographies: person.biographies?.map((b) => b.value),
          birthdays: person.birthdays?.map((b) => b.date),
          urls: person.urls?.map((u) => ({ value: u.value, type: u.type })),
          photo: person.photos?.[0]?.url,
        };
      },
      'get-contact',
    );
  },
};
