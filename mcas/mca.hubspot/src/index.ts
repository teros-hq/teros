#!/usr/bin/env bun

/**
 * HubSpot MCA v1.0.0
 *
 * HubSpot CRM integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from the backend via callbackUrl.
 *
 * Features:
 * - Contacts (CRUD, search)
 * - Companies (CRUD, associations)
 * - Deals (CRUD, pipelines, stages)
 * - Tickets (CRUD, pipelines)
 * - Engagements (calls, emails, meetings, notes, tasks)
 * - Associations (v4 API)
 * - Pipelines (deals, tickets)
 * - Lists (CRM v3 lists)
 * - Conversations / Inbox (read, reply)
 * - Search (v3 search API with filters)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { validateCredentials } from './lib';
import {
  // Contacts
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
  // Companies
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  updateCompany,
  // Deals
  createDeal,
  deleteDeal,
  getDeal,
  listDeals,
  updateDeal,
  // Tickets
  createTicket,
  deleteTicket,
  getTicket,
  listTickets,
  updateTicket,
  // Associations
  createAssociation,
  deleteAssociation,
  listAssociations,
  // Pipelines
  getPipeline,
  listPipelines,
  // Engagements
  createEngagement,
  deleteEngagement,
  getEngagement,
  listEngagements,
  // Lists
  getList,
  listLists,
  // Conversations
  getConversation,
  listConversations,
  sendConversationMessage,
  // Search
  search,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.hubspot',
  name: 'HubSpot',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies HubSpot OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const userSecrets = await context.getUserSecrets();

      // Check user secrets
      if (!userSecrets.ACCESS_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'HubSpot account not connected', {
          type: 'user_action',
          description: 'Connect your HubSpot account via OAuth to use this integration.',
        });
      } else {
        // Try to validate credentials
        try {
          await validateCredentials(context);
        } catch (apiError: any) {
          const msg = String(apiError?.message ?? '');
          if (/401|403|unauthori[sz]ed|token.*expired|token.*invalid/i.test(msg)) {
            builder.addIssue('AUTH_INVALID', 'HubSpot OAuth token is invalid or expired', {
              type: 'user_action',
              description: 'Reconnect your HubSpot account via OAuth.',
            });
          } else if (/429|rate.?limit/i.test(msg)) {
            builder.addIssue('RATE_LIMITED', 'HubSpot API rate limit hit', {
              type: 'auto_retry',
              description: 'Rate limit exceeded — will retry automatically.',
            });
          } else {
            builder.addIssue('DEPENDENCY_UNAVAILABLE', `HubSpot API error: ${apiError.message}`, {
              type: 'auto_retry',
              description: 'HubSpot API temporarily unavailable.',
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
          description: 'Ensure callbackUrl is provided and backend is reachable.',
        },
      );
    }

    return builder.build();
  },
});

// =============================================================================
// REGISTER TOOLS: SEARCH
// =============================================================================

server.tool('search', search);

// =============================================================================
// REGISTER TOOLS: CONTACTS
// =============================================================================

server.tool('create-contact', createContact);
server.tool('get-contact', getContact);
server.tool('list-contacts', listContacts);
server.tool('update-contact', updateContact);
server.tool('delete-contact', deleteContact);

// =============================================================================
// REGISTER TOOLS: COMPANIES
// =============================================================================

server.tool('create-company', createCompany);
server.tool('get-company', getCompany);
server.tool('list-companies', listCompanies);
server.tool('update-company', updateCompany);
server.tool('delete-company', deleteCompany);

// =============================================================================
// REGISTER TOOLS: DEALS
// =============================================================================

server.tool('create-deal', createDeal);
server.tool('get-deal', getDeal);
server.tool('list-deals', listDeals);
server.tool('update-deal', updateDeal);
server.tool('delete-deal', deleteDeal);

// =============================================================================
// REGISTER TOOLS: TICKETS
// =============================================================================

server.tool('create-ticket', createTicket);
server.tool('get-ticket', getTicket);
server.tool('list-tickets', listTickets);
server.tool('update-ticket', updateTicket);
server.tool('delete-ticket', deleteTicket);

// =============================================================================
// REGISTER TOOLS: ASSOCIATIONS
// =============================================================================

server.tool('create-association', createAssociation);
server.tool('delete-association', deleteAssociation);
server.tool('list-associations', listAssociations);

// =============================================================================
// REGISTER TOOLS: PIPELINES
// =============================================================================

server.tool('list-pipelines', listPipelines);
server.tool('get-pipeline', getPipeline);

// =============================================================================
// REGISTER TOOLS: ENGAGEMENTS
// =============================================================================

server.tool('create-engagement', createEngagement);
server.tool('get-engagement', getEngagement);
server.tool('list-engagements', listEngagements);
server.tool('delete-engagement', deleteEngagement);

// =============================================================================
// REGISTER TOOLS: LISTS
// =============================================================================

server.tool('list-lists', listLists);
server.tool('get-list', getList);

// =============================================================================
// REGISTER TOOLS: CONVERSATIONS
// =============================================================================

server.tool('list-conversations', listConversations);
server.tool('get-conversation', getConversation);
server.tool('send-conversation-message', sendConversationMessage);

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🔶 HubSpot MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start HubSpot MCA:', error);
    process.exit(1);
  });
