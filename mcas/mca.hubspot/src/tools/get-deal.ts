import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatDeal } from '../lib';

export const getDeal: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Retrieve a HubSpot deal by ID. Returns curated { id, name, amount, stage, pipeline, type, closeDate, probability, description, source, createdAt, updatedAt }. Params: dealId',
  parameters: {
    type: 'object',
    properties: {
      dealId: { type: 'string', description: 'HubSpot deal ID.' },
      properties: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional properties to include.',
      },
    },
    required: ['dealId'],
  },
  handler: async (args, context) => {
    const { dealId, properties } = args as {
      dealId: string;
      properties?: string[];
    };

    const defaultProps = ['dealname', 'amount', 'dealstage', 'pipeline', 'dealtype', 'closedate', 'probability', 'description', 'hs_analytics_source', 'createdate', 'hs_lastmodifieddate'];
    const allProps = properties ? [...new Set([...defaultProps, ...properties])] : defaultProps;

    const data = (await hubspotRequest(context, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      params: { properties: allProps.join(',') },
    })) as any;
    return formatDeal(data);
  },
};
