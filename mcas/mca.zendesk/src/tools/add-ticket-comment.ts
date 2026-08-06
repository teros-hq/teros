import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const addTicketComment: ToolConfig = {
  description:
    'Add a comment to a Zendesk ticket. Can be public (customer-visible) or internal note. Returns the updated ticket. Params: ticketId, body, public?.',
  parameters: {
    type: 'object',
    properties: {
      ticketId: {
        type: 'string',
        description: 'Zendesk ticket ID.',
      },
      body: {
        type: 'string',
        description: 'Comment text/body.',
      },
      public: {
        type: 'boolean',
        description: 'Whether the comment is public (customer-visible). Default true.',
      },
    },
    required: ['ticketId', 'body'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { ticketId, body, public: isPublic = true } = args as {
      ticketId: string;
      body: string;
      public?: boolean;
    };

    const result = (await zendeskRequest(context, `/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: {
          comment: {
            body,
            public: isPublic,
          },
        },
      },
    })) as any;

    const t = result.ticket;
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      updatedAt: t.updated_at,
      url: t.url,
    };
  },
};
