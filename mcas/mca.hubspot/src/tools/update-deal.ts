import type { ToolConfig } from '@teros/mca-sdk';
import { buildProperties, hubspotRequest, formatDeal } from '../lib';

export const updateDeal: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update an existing HubSpot deal. Idempotent per-field — safe to retry. Params: dealId, name?, amount?, stage?, pipeline?, type?, closeDate?, probability?, description?, properties?',
  parameters: {
    type: 'object',
    properties: {
      dealId: { type: 'string', description: 'HubSpot deal ID.' },
      name: { type: 'string', description: 'Deal name.' },
      amount: { type: 'number', description: 'Deal amount.' },
      stage: { type: 'string', description: 'Deal stage ID.' },
      pipeline: { type: 'string', description: 'Pipeline ID.' },
      type: { type: 'string', description: 'Deal type.', enum: ['newbusiness', 'existingbusiness'] },
      closeDate: { type: 'string', description: 'Expected close date (YYYY-MM-DD).' },
      probability: { type: 'number', description: 'Probability of closing (0-100).' },
      description: { type: 'string', description: 'Deal description.' },
      properties: {
        type: 'object',
        description: 'Additional HubSpot deal properties as key-value pairs.',
      },
    },
    required: ['dealId'],
  },
  handler: async (args, context) => {
    const { dealId, name, amount, stage, pipeline, type, closeDate, probability, description, properties: extraProps } = args as {
      dealId: string;
      name?: string;
      amount?: number;
      stage?: string;
      pipeline?: string;
      type?: string;
      closeDate?: string;
      probability?: number;
      description?: string;
      properties?: Record<string, string>;
    };

    const payload: Record<string, any> = {
      ...(name && { dealname: name }),
      ...(amount !== undefined && { amount }),
      ...(stage && { dealstage: stage }),
      ...(pipeline && { pipeline }),
      ...(type && { dealtype: type }),
      ...(closeDate && { closedate: closeDate }),
      ...(probability !== undefined && { probability }),
      ...(description && { description }),
      ...extraProps,
    };

    const data = (await hubspotRequest(context, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, {
      method: 'PATCH',
      body: buildProperties(payload),
    })) as any;

    return formatDeal(data);
  },
};
