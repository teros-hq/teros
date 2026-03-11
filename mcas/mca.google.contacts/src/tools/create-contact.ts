import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createContact: ToolConfig = {
  description: 'Create a new contact.',
  parameters: {
    type: 'object',
    properties: {
      givenName: {
        type: 'string',
        description: 'First name',
      },
      familyName: {
        type: 'string',
        description: 'Last name',
      },
      email: {
        type: 'string',
        description: 'Email address',
      },
      phone: {
        type: 'string',
        description: 'Phone number',
      },
      organization: {
        type: 'string',
        description: 'Company/organization name',
      },
      title: {
        type: 'string',
        description: 'Job title',
      },
      notes: {
        type: 'string',
        description: 'Notes/biography',
      },
    },
    required: ['givenName'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { givenName, familyName, email, phone, organization, title, notes } = args as {
      givenName: string;
      familyName?: string;
      email?: string;
      phone?: string;
      organization?: string;
      title?: string;
      notes?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const requestBody: any = {
          names: [{ givenName, familyName }],
        };

        if (email) {
          requestBody.emailAddresses = [{ value: email }];
        }

        if (phone) {
          requestBody.phoneNumbers = [{ value: phone }];
        }

        if (organization || title) {
          requestBody.organizations = [{ name: organization, title }];
        }

        if (notes) {
          requestBody.biographies = [{ value: notes, contentType: 'TEXT_PLAIN' }];
        }

        const response = await clients.people.people.createContact({
          requestBody,
          personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies',
        });

        return {
          success: true,
          resourceName: response.data.resourceName,
          name: response.data.names?.[0]?.displayName,
        };
      },
      'create-contact',
    );
  },
};
