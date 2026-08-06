import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildSendTestBody, coerceInt, validateSendTestArgs } from './_helpers';

/**
 * send-test-email — POST /emailCampaigns/{campaignId}/sendTest.
 *
 * Sends a REAL test email of the campaign to the given addresses (≤99). It puts
 * mail on the wire with no undo, so it carries `irreversible` +
 * `destructiveHint` like send-transactional-email.
 */
export const sendTestEmail: ToolConfig = {
  description:
    'Send a test of an email campaign to specific addresses (POST /emailCampaigns/{campaignId}/sendTest). Delivers REAL emails to the given testers. Returns { campaignId, emailTo }. Params: campaignId (required, integer), emailTo (required, array of up to 99 email addresses).',
  parameters: {
    type: 'object',
    properties: {
      campaignId: { type: 'number', description: 'Id of the campaign to test (required).' },
      emailTo: {
        type: 'array',
        description: 'Recipients of the test (1-99 email addresses).',
        items: { type: 'string' },
      },
    },
    required: ['campaignId', 'emailTo'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateSendTestArgs(args);
    const a = args as Record<string, unknown>;
    const id = coerceInt(a.campaignId) as number;
    const body = buildSendTestBody(a);

    await brevoRequest<unknown>(context, `/emailCampaigns/${id}/sendTest`, {
      method: 'POST',
      body,
    });
    return { campaignId: id, emailTo: body.emailTo };
  },
};
