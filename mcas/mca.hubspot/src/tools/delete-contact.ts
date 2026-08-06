import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

export const deleteContact: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Archive (soft delete) a HubSpot contact. Irreversible via API. Returns { success, contactId }.',
  parameters: {
    type: 'object',
    properties: {
      contactId: { type: 'string', description: 'HubSpot contact ID to archive.' },
    },
    required: ['contactId'],
  },
  handler: async (args, context) => {
    const { contactId } = args as { contactId: string };
    await hubspotRequest(context, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { method: 'DELETE' });
    return { success: true, contactId };
  },
};
