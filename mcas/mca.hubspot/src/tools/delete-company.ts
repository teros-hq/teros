import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

export const deleteCompany: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Archive (soft delete) a HubSpot company. Irreversible via API. Returns { success, companyId }.',
  parameters: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: 'HubSpot company ID to archive.' },
    },
    required: ['companyId'],
  },
  handler: async (args, context) => {
    const { companyId } = args as { companyId: string };
    await hubspotRequest(context, `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, { method: 'DELETE' });
    return { success: true, companyId };
  },
};
