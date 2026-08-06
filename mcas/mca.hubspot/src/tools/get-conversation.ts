import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatConversation, formatConversationMessage } from '../lib';

export const getConversation: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a HubSpot conversation by ID, including messages. Params: conversationId, includeMessages?',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'HubSpot conversation ID.' },
      includeMessages: {
        type: 'boolean',
        description: 'Include messages in the response. Default true.',
      },
      limit: { type: 'number', description: 'Max messages to include. Default 50.' },
    },
    required: ['conversationId'],
  },
  handler: async (args, context) => {
    const { conversationId, includeMessages = true, limit = 50 } = args as {
      conversationId: string;
      includeMessages?: boolean;
      limit?: number;
    };

    const conversation = (await hubspotRequest(
      context,
      `/conversations/v3/conversations/${encodeURIComponent(conversationId)}`,
    )) as any;

    let messages: any[] = [];
    if (includeMessages) {
      try {
        const messagesData = (await hubspotRequest(
          context,
          `/conversations/v3/conversations/${encodeURIComponent(conversationId)}/messages`,
          { params: { limit: Math.min(limit, 100) } },
        )) as any;
        messages = (messagesData.results ?? []).map(formatConversationMessage);
      } catch {
        // Messages may not be available — best effort
      }
    }

    return {
      ...formatConversation(conversation),
      messages,
      messageCount: messages.length,
    };
  },
};
