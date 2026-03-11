import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const replyConversation: ToolConfig = {
  description:
    'Reply to an Intercom conversation as an admin. Can send a public reply to the customer or add a private internal note.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The Intercom conversation ID',
      },
      body: {
        type: 'string',
        description: 'The reply text (plain text or HTML)',
      },
      type: {
        type: 'string',
        enum: ['comment', 'note'],
        description: '"comment" sends a public reply to the customer; "note" adds a private internal note visible only to the team (default: comment)',
      },
      adminId: {
        type: 'string',
        description: 'The admin ID to reply as. If omitted, uses the token owner.',
      },
    },
    required: ['conversationId', 'body'],
  },
  handler: async (args, context) => {
    const { conversationId, body, type = 'comment', adminId } = args as {
      conversationId: string;
      body: string;
      type?: string;
      adminId?: string;
    };

    // Get the token owner's admin ID if not provided
    let replyAdminId = adminId;
    if (!replyAdminId) {
      const me = (await intercomRequest(context, '/me')) as Record<string, unknown>;
      replyAdminId = me.id as string;
    }

    return intercomRequest(context, `/conversations/${conversationId}/reply`, {
      method: 'POST',
      body: {
        message_type: type,
        type: 'admin',
        admin_id: replyAdminId,
        body,
      },
    });
  },
};
