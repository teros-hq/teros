import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { clampInt, shapeCampaign, validateEnum } from './_helpers';

const CAMPAIGN_TYPES = ['classic', 'trigger'] as const;
/**
 * Allowed values for the GET /emailCampaigns `status` query FILTER.
 *
 * CAMEL-CASE `inProcess` is the real query-param value — verified against the
 * official Brevo SDK (`getbrevo/brevo-node`, `getEmailCampaigns`), whose
 * generated union is exactly `'suspended' | 'archive' | 'sent' | 'queued' |
 * 'draft' | 'inProcess'`. Passing snake_case `in_process` here makes Brevo
 * ignore the filter (or 400). NOTE: the snake_case `in_process` you may see in
 * a campaign's RESPONSE `status` is a separate field and is NOT touched here.
 */
export const CAMPAIGN_STATUSES = [
  'draft',
  'sent',
  'archive',
  'queued',
  'suspended',
  'inProcess',
] as const;

interface ListCampaignsResponse {
  campaigns?: unknown[];
  count?: number;
}

/**
 * list-email-campaigns — GET /emailCampaigns.
 */
export const listEmailCampaigns: ToolConfig = {
  description:
    'List email campaigns from Brevo (GET /emailCampaigns). Returns { campaigns:[{id,name,subject,type,status,scheduledAt,createdAt,modifiedAt}], count, type, status, limit, offset }. Params: type? (classic|trigger), status? (draft|sent|archive|queued|suspended|inProcess), limit? (1-100, default 50), offset? (default 0).',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Filter by campaign type.',
        enum: ['classic', 'trigger'],
      },
      status: {
        type: 'string',
        description: 'Filter by campaign status.',
        enum: ['draft', 'sent', 'archive', 'queued', 'suspended', 'inProcess'],
      },
      limit: {
        type: 'number',
        description: 'Max campaigns to return (1-100, default 50).',
        default: 50,
      },
      offset: {
        type: 'number',
        description: 'Index of the first campaign for pagination (default 0).',
        default: 0,
      },
    },
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const type = validateEnum(a.type, CAMPAIGN_TYPES, 'type');
    const status = validateEnum(a.status, CAMPAIGN_STATUSES, 'status');
    const limit = clampInt(a.limit, 1, 100, 50);
    const offset = clampInt(a.offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const res = await brevoRequest<ListCampaignsResponse>(context, '/emailCampaigns', {
      query: { type, status, limit, offset },
    });

    const campaigns = (res.campaigns ?? []).map(shapeCampaign);
    return {
      campaigns,
      count: typeof res.count === 'number' ? res.count : campaigns.length,
      type: type ?? null,
      status: status ?? null,
      limit,
      offset,
    };
  },
};
