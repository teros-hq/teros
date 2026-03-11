import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const tagConversation: ToolConfig = {
  description:
    'Add or remove tags from an Intercom conversation.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The Intercom conversation ID',
      },
      tagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag IDs to add to the conversation',
      },
      removeTagIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tag IDs to remove from the conversation',
      },
    },
    required: ['conversationId'],
  },
  handler: async (args, context) => {
    const { conversationId, tagIds = [], removeTagIds = [] } = args as {
      conversationId: string;
      tagIds?: string[];
      removeTagIds?: string[];
    };

    const me = (await intercomRequest(context, '/me')) as Record<string, unknown>;
    const adminId = me.id as string;

    const results: unknown[] = [];

    for (const tagId of tagIds) {
      const result = await intercomRequest(context, `/conversations/${conversationId}/tags`, {
        method: 'POST',
        body: { id: tagId, admin_id: adminId },
      });
      results.push({ action: 'added', tagId, result });
    }

    for (const tagId of removeTagIds) {
      const result = await intercomRequest(context, `/conversations/${conversationId}/tags/${tagId}`, {
        method: 'DELETE',
        body: { admin_id: adminId },
      });
      results.push({ action: 'removed', tagId, result });
    }

    return { success: true, operations: results };
  },
};
