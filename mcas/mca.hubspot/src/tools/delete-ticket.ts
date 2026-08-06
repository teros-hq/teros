import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest } from '../lib';

export const deleteTicket: ToolConfig = {
  annotations: { readOnlyHint: false, irreversible: true },
  description:
    'Archive (soft delete) a HubSpot ticket. Irreversible via API. Returns { success, ticketId }.',
  parameters: {
    type: 'object',
    properties: {
      ticketId: { type: 'string', description: 'HubSpot ticket ID to archive.' },
    },
    required: ['ticketId'],
  },
  handler: async (args, context) => {
    const { ticketId } = args as { ticketId: string };
    await hubspotRequest(context, `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, { method: 'DELETE' });
    return { success: true, ticketId };
  },
};
