import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const deleteTicket: ToolConfig = {
  description: 'Delete (soft-delete) a Zendesk ticket by ID. Returns { success, ticketId }.',
  parameters: {
    type: 'object',
    properties: {
      ticketId: {
        type: 'string',
        description: 'Zendesk ticket ID to delete.',
      },
    },
    required: ['ticketId'],
  },
  annotations: { readOnlyHint: false, irreversible: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { ticketId } = args as { ticketId: string };

    await zendeskRequest(context, `/tickets/${ticketId}.json`, {
      method: 'DELETE',
    });

    return { success: true, ticketId };
  },
};
