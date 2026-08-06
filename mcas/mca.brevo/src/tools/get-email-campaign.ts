import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { coerceInt, shapeCampaign } from './_helpers';

/**
 * get-email-campaign — GET /emailCampaigns/{campaignId}.
 *
 * Detail of a single campaign (status, schedule, subject). Useful right after
 * create-email-campaign to confirm the draft before sending.
 */
export const getEmailCampaign: ToolConfig = {
  description:
    'Get one email campaign by id from Brevo (GET /emailCampaigns/{campaignId}). Returns { id, name, subject, type, status, scheduledAt, createdAt, modifiedAt }. Params: campaignId (required, integer).',
  parameters: {
    type: 'object',
    properties: {
      campaignId: { type: 'number', description: 'Id of the campaign (required).' },
    },
    required: ['campaignId'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const id = coerceInt((args as Record<string, unknown>)?.campaignId);
    if (id == null) throw new Error('campaignId is required and must be an integer.');

    const res = await brevoRequest<unknown>(context, `/emailCampaigns/${id}`);
    return shapeCampaign(res);
  },
};
