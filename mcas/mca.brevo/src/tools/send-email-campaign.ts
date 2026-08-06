import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { coerceInt } from './_helpers';

/**
 * send-email-campaign — POST /emailCampaigns/{campaignId}/sendNow.
 *
 * Sends the campaign to ALL its recipients immediately. IRREVERSIBLE — there is
 * no undo — so it carries `irreversible` + `destructiveHint` and is excluded
 * from grouped "Allow all". No request body. The campaign must be a draft with
 * recipients already set (via create-email-campaign).
 */
export const sendEmailCampaign: ToolConfig = {
  description:
    'Send an email campaign immediately (POST /emailCampaigns/{campaignId}/sendNow). IRREVERSIBLE — delivers to every recipient with no undo. The campaign must be a draft with recipients set. Returns { campaignId, sent }. Params: campaignId (required, integer).',
  parameters: {
    type: 'object',
    properties: {
      campaignId: { type: 'number', description: 'Id of the campaign to send now (required).' },
    },
    required: ['campaignId'],
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
    const id = coerceInt((args as Record<string, unknown>)?.campaignId);
    if (id == null) throw new Error('campaignId is required and must be an integer.');

    await brevoRequest<unknown>(context, `/emailCampaigns/${id}/sendNow`, { method: 'POST' });
    return { campaignId: id, sent: true };
  },
};
