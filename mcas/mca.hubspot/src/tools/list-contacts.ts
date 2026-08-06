import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatContact } from '../lib';

export const listContacts: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List HubSpot contacts with optional filters. Returns curated rows { id, email, firstName, lastName, phone, company, jobTitle, lifecycleStage, createdAt }. Params: limit (1-100, def 50), after, properties?',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Results per page. Min 1, max 100, default 50.' },
      after: { type: 'string', description: 'Pagination cursor from previous response.paging.next.after.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional contact properties to include.',
      },
    },
  },
  handler: async (args, context) => {
    const { limit = 50, after, properties } = args as {
      limit?: number;
      after?: string;
      properties?: string[];
    };

    const defaultProps = ['email', 'firstname', 'lastname', 'phone', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status', 'createdate', 'lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const params: Record<string, any> = {
      limit: Math.min(Math.max(limit, 1), 100),
      properties: allProps.join(','),
    };
    if (after) params.after = after;

    const data = (await hubspotRequest(context, '/crm/v3/objects/contacts', { params })) as any;

    return {
      contacts: (data.results ?? []).map(formatContact),
      total: data.results?.length ?? 0,
      hasMore: !!data.paging?.next?.after,
      nextCursor: data.paging?.next?.after ?? null,
    };
  },
};
