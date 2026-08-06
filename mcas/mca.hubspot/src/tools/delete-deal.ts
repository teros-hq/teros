import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

export const deleteDeal: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Archive (soft delete) a HubSpot deal. Irreversible via API. Returns { success, dealId }.',
  parameters: {
    type: 'object',
    properties: {
      dealId: { type: 'string', description: 'HubSpot deal ID to archive.' },
    },
    required: ['dealId'],
  },
  handler: async (args, context) => {
    const { dealId } = args as { dealId: string };
    await hubspotRequest(context, `/crm/v3/objects/deals/${encodeURIComponent(dealId)}`, { method: 'DELETE' });
    return { success: true, dealId };
  },
};
