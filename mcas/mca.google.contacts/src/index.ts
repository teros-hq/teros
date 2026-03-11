#!/usr/bin/env bun

/**
 * Google Contacts MCA v1.1
 *
 * Google Contacts management using McaServer (auto-detects transport).
 * Includes support for contact groups (labels).
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { initializeGoogleClients } from './lib';
import {
  // Contact tools
  createContact,
  deleteContact,
  getContact,
  listContacts,
  searchContacts,
  updateContact,
  // Contact group tools
  listContactGroups,
  getContactGroup,
  createContactGroup,
  updateContactGroup,
  deleteContactGroup,
  addContactsToGroup,
  removeContactsFromGroup,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.contacts',
  name: 'Google Contacts',
  version: '1.1.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await context.getUserSecrets();

      if (!systemSecrets.CLIENT_ID) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        });
      }
      if (!systemSecrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        });
      }

      if (!userSecrets.ACCESS_TOKEN || !userSecrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Google account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Contacts',
        });
      } else {
        try {
          const clients = await initializeGoogleClients(context);
          await clients.people.people.connections.list({
            resourceName: 'people/me',
            pageSize: 1,
            personFields: 'names',
          });
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Google access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `Google API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'Google API temporarily unavailable',
            });
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER CONTACT TOOLS
// =============================================================================

server.tool('list-contacts', listContacts);
server.tool('get-contact', getContact);
server.tool('search-contacts', searchContacts);
server.tool('create-contact', createContact);
server.tool('update-contact', updateContact);
server.tool('delete-contact', deleteContact);

// =============================================================================
// REGISTER CONTACT GROUP TOOLS
// =============================================================================

server.tool('list-contact-groups', listContactGroups);
server.tool('get-contact-group', getContactGroup);
server.tool('create-contact-group', createContactGroup);
server.tool('update-contact-group', updateContactGroup);
server.tool('delete-contact-group', deleteContactGroup);
server.tool('add-contacts-to-group', addContactsToGroup);
server.tool('remove-contacts-from-group', removeContactsFromGroup);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Google Contacts MCA] Fatal error:', error);
  process.exit(1);
});
