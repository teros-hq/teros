#!/usr/bin/env bun

/**
 * Intercom MCA v1.0
 *
 * Intercom REST API integration using McaServer with HTTP transport.
 * Authenticates via Access Token (API key) stored as user secret.
 *
 * Tools:
 * - Workspace: get-workspace
 * - Conversations: search-conversations, get-conversation, reply-conversation,
 *                  assign-conversation, update-conversation, tag-conversation
 * - Team & Admins: list-admins, list-teams, list-tags
 * - Contacts: get-contact, search-contacts
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { intercomRequest } from './lib';
import {
  assignConversation,
  getContact,
  getConversation,
  getWorkspace,
  listAdmins,
  listTags,
  listTeams,
  replyConversation,
  searchContacts,
  searchConversations,
  tagConversation,
  updateConversation,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.intercom',
  name: 'Intercom',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Intercom API token and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const token = userSecrets.ACCESS_TOKEN || userSecrets.access_token;

      if (!token) {
        builder.addIssue('AUTH_REQUIRED', 'Intercom ACCESS_TOKEN not configured', {
          type: 'user_action',
          description:
            'Go to your Intercom Developer Hub → your app → Authentication → Access Token, and paste it here.',
        });
        return builder.build();
      }

      // Validate token with a real API call
      try {
        await intercomRequest(context, '/me');
      } catch (apiError: any) {
        if (apiError.message?.includes('401') || apiError.message?.includes('403')) {
          builder.addIssue('AUTH_EXPIRED', 'Intercom token is invalid or expired', {
            type: 'user_action',
            description: 'Generate a new Access Token in the Intercom Developer Hub.',
          });
        } else {
          builder.addIssue('DEPENDENCY_UNAVAILABLE', `Intercom API error: ${apiError.message}`, {
            type: 'auto_retry',
            description: 'Intercom API temporarily unavailable. Try again in a moment.',
          });
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to load secrets',
        {
          type: 'admin_action',
          description: 'Ensure the backend is reachable and secrets are configured.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// WORKSPACE
// =============================================================================

server.tool('get-workspace', getWorkspace);

// =============================================================================
// CONVERSATIONS
// =============================================================================

server.tool('search-conversations', searchConversations);
server.tool('get-conversation', getConversation);
server.tool('reply-conversation', replyConversation);
server.tool('assign-conversation', assignConversation);
server.tool('update-conversation', updateConversation);
server.tool('tag-conversation', tagConversation);

// =============================================================================
// TEAM & ADMINS
// =============================================================================

server.tool('list-admins', listAdmins);
server.tool('list-teams', listTeams);
server.tool('list-tags', listTags);

// =============================================================================
// CONTACTS
// =============================================================================

server.tool('get-contact', getContact);
server.tool('search-contacts', searchContacts);

// =============================================================================
// START
// =============================================================================

server.start().catch((error) => {
  console.error('[Intercom MCA] Fatal error:', error);
  process.exit(1);
});
