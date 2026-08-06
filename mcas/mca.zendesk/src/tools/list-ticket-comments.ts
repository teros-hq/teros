import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const listTicketComments: ToolConfig = {
  description:
    'List all comments (public and internal notes) on a Zendesk ticket. Returns curated rows { id, authorId, body, public, createdAt }. Params: ticketId.',
  parameters: {
    type: 'object',
    properties: {
      ticketId: {
        type: 'string',
        description: 'Zendesk ticket ID.',
      },
    },
    required: ['ticketId'],
  },
  annotations: { readOnlyHint: true, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { ticketId } = args as { ticketId: string };

    const result = (await zendeskRequest(
      context,
      `/tickets/${ticketId}/comments.json`,
    )) as any;

    const comments = (result.comments ?? []).map((c: any) => ({
      id: c.id,
      authorId: c.author_id,
      body: c.body,
      public: c.public,
      htmlBody: c.html_body,
      createdAt: c.created_at,
      attachments: (c.attachments ?? []).map((a: any) => ({
        id: a.id,
        fileName: a.file_name,
        url: a.content_url,
        size: a.size,
      })),
    }));

    return {
      ticketId,
      comments,
      count: comments.length,
    };
  },
};
