import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest } from '../lib';

export const addCommentWithAttachment: ToolConfig = {
  description:
    'Add a comment to a Zendesk ticket with file attachments. Uses upload tokens from upload-attachment. Returns the updated ticket. Params: ticketId, body, uploadTokens?, public?.',
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
      uploadTokens: {
        type: 'array',
        items: { type: 'string' },
        description: 'Upload tokens from upload-attachment tool.',
      },
      public: {
        type: 'boolean',
        description: 'Whether the comment is public (customer-visible). Default true.',
      },
    },
    required: ['ticketId', 'body'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { ticketId, body, uploadTokens, public: isPublic = true } = args as {
      ticketId: string;
      body: string;
      uploadTokens?: string[];
      public?: boolean;
    };

    const comment: Record<string, unknown> = { body, public: isPublic };
    if (uploadTokens && uploadTokens.length > 0) {
      comment.uploads = uploadTokens;
    }

    const result = (await zendeskRequest(context, `/tickets/${ticketId}.json`, {
      method: 'PUT',
      body: {
        ticket: { comment },
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
