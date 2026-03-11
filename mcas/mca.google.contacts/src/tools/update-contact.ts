import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const updateContact: ToolConfig = {
  description: 'Update an existing contact.',
  parameters: {
    type: 'object',
    properties: {
      resourceName: {
        type: 'string',
        description: "Contact resource name (e.g., 'people/c123456789')",
      },
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
    },
    required: ['resourceName'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { resourceName, givenName, familyName, email, phone, organization, title } = args as {
      resourceName: string;
      givenName?: string;
      familyName?: string;
      email?: string;
      phone?: string;
      organization?: string;
      title?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        // First get the current contact to get etag
        const current = await clients.people.people.get({
          resourceName,
          personFields: 'names,emailAddresses,phoneNumbers,organizations',
        });

        const updatePersonFields: string[] = [];
        const requestBody: any = {
          etag: current.data.etag,
        };

        if (givenName !== undefined || familyName !== undefined) {
          requestBody.names = [
            {
              givenName: givenName ?? current.data.names?.[0]?.givenName,
              familyName: familyName ?? current.data.names?.[0]?.familyName,
            },
          ];
          updatePersonFields.push('names');
        }

        if (email !== undefined) {
          requestBody.emailAddresses = [{ value: email }];
          updatePersonFields.push('emailAddresses');
        }

        if (phone !== undefined) {
          requestBody.phoneNumbers = [{ value: phone }];
          updatePersonFields.push('phoneNumbers');
        }

        if (organization !== undefined || title !== undefined) {
          requestBody.organizations = [
            {
              name: organization ?? current.data.organizations?.[0]?.name,
              title: title ?? current.data.organizations?.[0]?.title,
            },
          ];
          updatePersonFields.push('organizations');
        }

        if (updatePersonFields.length === 0) {
          return { success: false, message: 'No fields to update' };
        }

        const response = await clients.people.people.updateContact({
          resourceName,
          updatePersonFields: updatePersonFields.join(','),
          requestBody,
          personFields: 'names,emailAddresses,phoneNumbers,organizations',
        });

        return {
          success: true,
          resourceName: response.data.resourceName,
          name: response.data.names?.[0]?.displayName,
        };
      },
      'update-contact',
    );
  },
};
