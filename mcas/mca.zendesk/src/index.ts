#!/usr/bin/env bun

/**
 * Zendesk MCA v1.1.0
 *
 * Zendesk REST API integration using McaServer with HTTP transport.
 * Authenticates via API Token (Basic Auth) with SUBDOMAIN, EMAIL, and API_TOKEN.
 *
 * Features:
 * - Tickets: list, get, create, update, delete, search
 * - Ticket Comments: list, add (public/private), add with attachments
 * - Users: list, get, create, update
 * - Organizations: list, get, create
 * - Views: list, get tickets in view
 * - Groups: list
 * - Triggers & Automations: read-only list
 * - Attachments: upload, get details
 * - Webhooks: list
 * - Satisfaction Ratings: list, filter by score/ticket
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { validateCredentials } from './lib';
import {
  // Tickets
  addCommentWithAttachment,
  addTicketComment,
  createTicket,
  deleteTicket,
  getAttachment,
  getTicket,
  listTicketComments,
  listTickets,
  searchTickets,
  updateTicket,
  uploadAttachment,
  // Users
  createUser,
  getUser,
  listUsers,
  updateUser,
  // Organizations
  createOrganization,
  getOrganization,
  listOrganizations,
  // Views
  getViewTickets,
  listViews,
  // Groups
  listGroups,
  // Triggers & Automations
  listAutomations,
  listTriggers,
  // Webhooks
  listWebhooks,
  // Satisfaction Ratings
  listSatisfactionRatings,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.zendesk',
  name: 'Zendesk',
  version: '1.1.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies Zendesk credentials and connectivity.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.1.0');

    try {
      const userSecrets = await context.getUserSecrets();
      const subdomain = userSecrets.SUBDOMAIN;
      const email = userSecrets.EMAIL;
      const apiToken = userSecrets.API_TOKEN;

      if (!subdomain || !email || !apiToken) {
        const missing: string[] = [];
        if (!subdomain) missing.push('SUBDOMAIN');
        if (!email) missing.push('EMAIL');
        if (!apiToken) missing.push('API_TOKEN');
        builder.addIssue('USER_CONFIG_MISSING', `Zendesk secrets missing: ${missing.join(', ')}`, {
          type: 'user_action',
          description: 'Configure SUBDOMAIN, EMAIL, and API_TOKEN in app settings.',
        });
        return builder.build();
      }

      // Validate credentials with a real API call
      try {
        await validateCredentials(context);
      } catch (apiError: any) {
        const msg = String(apiError?.message ?? '');
        if (/401|403|unauthori[sz]ed/i.test(msg)) {
          builder.addIssue('AUTH_INVALID', 'Zendesk credentials are invalid', {
            type: 'user_action',
            description: 'Check that your EMAIL and API_TOKEN are correct.',
          });
        } else if (/404|not found/i.test(msg)) {
          builder.addIssue('CONFIG_INVALID', 'Zendesk subdomain not found', {
            type: 'user_action',
            description: 'Verify your SUBDOMAIN is correct.',
          });
        } else {
          builder.addIssue('DEPENDENCY_UNAVAILABLE', `Zendesk API error: ${apiError.message}`, {
            type: 'auto_retry',
            description: 'Zendesk API temporarily unavailable.',
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
// REGISTER TOOLS: TICKETS
// =============================================================================

server.tool('list-tickets', listTickets);
server.tool('get-ticket', getTicket);
server.tool('create-ticket', createTicket);
server.tool('update-ticket', updateTicket);
server.tool('delete-ticket', deleteTicket);
server.tool('search-tickets', searchTickets);

// =============================================================================
// REGISTER TOOLS: TICKET COMMENTS
// =============================================================================

server.tool('list-ticket-comments', listTicketComments);
server.tool('add-ticket-comment', addTicketComment);
server.tool('add-comment-with-attachment', addCommentWithAttachment);

// =============================================================================
// REGISTER TOOLS: ATTACHMENTS
// =============================================================================

server.tool('upload-attachment', uploadAttachment);
server.tool('get-attachment', getAttachment);

// =============================================================================
// REGISTER TOOLS: USERS
// =============================================================================

server.tool('list-users', listUsers);
server.tool('get-user', getUser);
server.tool('create-user', createUser);
server.tool('update-user', updateUser);

// =============================================================================
// REGISTER TOOLS: ORGANIZATIONS
// =============================================================================

server.tool('list-organizations', listOrganizations);
server.tool('get-organization', getOrganization);
server.tool('create-organization', createOrganization);

// =============================================================================
// REGISTER TOOLS: VIEWS
// =============================================================================

server.tool('list-views', listViews);
server.tool('get-view-tickets', getViewTickets);

// =============================================================================
// REGISTER TOOLS: GROUPS
// =============================================================================

server.tool('list-groups', listGroups);

// =============================================================================
// REGISTER TOOLS: TRIGGERS & AUTOMATIONS (read-only)
// =============================================================================

server.tool('list-triggers', listTriggers);
server.tool('list-automations', listAutomations);

// =============================================================================
// REGISTER TOOLS: WEBHOOKS
// =============================================================================

server.tool('list-webhooks', listWebhooks);

// =============================================================================
// REGISTER TOOLS: SATISFACTION RATINGS
// =============================================================================

server.tool('list-satisfaction-ratings', listSatisfactionRatings);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Zendesk MCA] Fatal error:', error);
  process.exit(1);
});
