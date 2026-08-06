#!/usr/bin/env npx tsx

/**
 * Brevo MCA — email marketing integration.
 *
 * Tools:
 *   - send-transactional-email  POST /smtp/email
 *   - list-contacts             GET  /contacts
 *   - create-contact            POST /contacts
 *   - get-contact               GET  /contacts/{identifier}
 *   - update-contact            PUT  /contacts/{identifier}
 *   - delete-contact            DELETE /contacts/{identifier}
 *   - add-contact-to-list       POST /contacts/lists/{id}/contacts/add
 *   - remove-contact-from-list  POST /contacts/lists/{id}/contacts/remove
 *   - import-contacts           POST /contacts/import
 *   - list-attributes           GET  /contacts/attributes
 *   - list-segments             GET  /contacts/segments
 *   - list-folders              GET  /contacts/folders
 *   - list-lists                GET  /contacts/lists
 *   - create-list               POST /contacts/lists
 *   - list-email-templates      GET  /smtp/templates
 *   - create-email-template     POST /smtp/templates
 *   - list-email-campaigns      GET  /emailCampaigns
 *   - get-email-campaign        GET  /emailCampaigns/{id}
 *   - create-email-campaign     POST /emailCampaigns
 *   - send-test-email           POST /emailCampaigns/{id}/sendTest
 *   - send-email-campaign       POST /emailCampaigns/{id}/sendNow
 *   - get-email-event-report    GET  /smtp/statistics/events
 *   - get-aggregated-smtp-report GET /smtp/statistics/aggregatedReport
 *   - -health-check             GET  /account (validates the API key)
 *
 * Auth: per-user `api-key` HEADER (BREVO_API_KEY), per-app container.
 * Handlers return PLAIN DATA objects (the SDK serializes them) — never
 * { content, structuredContent } and never pre-composed UI strings.
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { BrevoApiError } from './lib/_brevo-error';
import { brevoRequest } from './lib/brevo-client';
import { addContactToList } from './tools/add-contact-to-list';
import { createContact } from './tools/create-contact';
import { createEmailCampaign } from './tools/create-email-campaign';
import { createEmailTemplate } from './tools/create-email-template';
import { createList } from './tools/create-list';
import { deleteContact } from './tools/delete-contact';
import { getAggregatedSmtpReport } from './tools/get-aggregated-smtp-report';
import { getContact } from './tools/get-contact';
import { getEmailCampaign } from './tools/get-email-campaign';
import { getEmailEventReport } from './tools/get-email-event-report';
import { importContacts } from './tools/import-contacts';
import { listAttributes } from './tools/list-attributes';
import { listContacts } from './tools/list-contacts';
import { listEmailCampaigns } from './tools/list-email-campaigns';
import { listEmailTemplates } from './tools/list-email-templates';
import { listFolders } from './tools/list-folders';
import { listLists } from './tools/list-lists';
import { listSegments } from './tools/list-segments';
import { removeContactFromList } from './tools/remove-contact-from-list';
import { sendEmailCampaign } from './tools/send-email-campaign';
import { sendTestEmail } from './tools/send-test-email';
import { sendTransactionalEmail } from './tools/send-transactional-email';
import { updateContact } from './tools/update-contact';

const VERSION = '1.0.0';

const server = new McaServer({
  id: 'mca.brevo',
  name: 'Brevo',
  version: VERSION,
});

// ============================================================================
// HEALTH CHECK — validates BREVO_API_KEY against GET /account
// ============================================================================

server.tool('-health-check', {
  description: 'Internal health check. Validates the Brevo API key against GET /account.',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    let userSecrets: Record<string, string> = {};
    try {
      userSecrets = await context.getUserSecrets();
    } catch {
      // treated as "key missing" by the builder below
    }

    const builder = new HealthCheckBuilder({ user: userSecrets })
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()))
      .requireUserSecret('BREVO_API_KEY', {
        description:
          'Add your Brevo API key in the app settings (Brevo → Settings → SMTP & API → API Keys).',
      });

    // Only ping the API when a key is actually present — otherwise the
    // requireUserSecret issue above already explains what to do.
    if (userSecrets.BREVO_API_KEY) {
      try {
        await brevoRequest(context, '/account');
      } catch (err) {
        if (err instanceof BrevoApiError && err.code === 'AUTH_INVALID') {
          builder.addIssue('AUTH_INVALID', err.upstreamMessage, {
            type: 'user_action',
            description: err.action.description,
          });
        } else {
          const message = err instanceof Error ? err.message : 'Brevo API unreachable';
          builder.addIssue('DEPENDENCY_UNAVAILABLE', message, {
            type: 'auto_retry',
            description: 'Brevo API temporarily unavailable.',
          });
        }
      }
    }

    return builder.build();
  },
});

// ============================================================================
// TOOLS
// ============================================================================

server.tool('send-transactional-email', sendTransactionalEmail);
server.tool('list-contacts', listContacts);
server.tool('create-contact', createContact);
server.tool('get-contact', getContact);
server.tool('update-contact', updateContact);
server.tool('delete-contact', deleteContact);
server.tool('add-contact-to-list', addContactToList);
server.tool('remove-contact-from-list', removeContactFromList);
server.tool('import-contacts', importContacts);
server.tool('list-attributes', listAttributes);
server.tool('list-segments', listSegments);
server.tool('list-folders', listFolders);
server.tool('list-lists', listLists);
server.tool('create-list', createList);
server.tool('list-email-templates', listEmailTemplates);
server.tool('create-email-template', createEmailTemplate);
server.tool('list-email-campaigns', listEmailCampaigns);
server.tool('get-email-campaign', getEmailCampaign);
server.tool('create-email-campaign', createEmailCampaign);
server.tool('send-test-email', sendTestEmail);
server.tool('send-email-campaign', sendEmailCampaign);
server.tool('get-email-event-report', getEmailEventReport);
server.tool('get-aggregated-smtp-report', getAggregatedSmtpReport);

// ============================================================================
// START
// ============================================================================

server.start().catch((error) => {
  console.error('[Brevo MCA] Fatal error:', error);
  process.exit(1);
});
