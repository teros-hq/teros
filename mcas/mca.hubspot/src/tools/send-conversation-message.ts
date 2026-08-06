import type { ToolConfig } from '@teros/mca-sdk';
import { hubspotRequest, formatConversationMessage } from '../lib';

export const sendConversationMessage: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Send a message in a HubSpot conversation (inbox reply). Params: conversationId, text, channelId?',
  parameters: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'HubSpot conversation ID.' },
      text: { type: 'string', description: 'Message text content.' },
      channelId: { type: 'string', description: 'Optional channel ID override.' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            name: { type: 'string' },
          },
        },
        description: 'Optional message attachments.',
      },
    },
    required: ['conversationId', 'text'],
  },
  handler: async (args, context) => {
    const { conversationId, text, channelId, attachments } = args as {
      conversationId: string;
      text: string;
      channelId?: string;
      attachments?: Array<{ url: string; name: string }>;
    };

    const body: Record<string, any> = {
      type: 'MESSAGE',
      text,
      ...(channelId && { channelId }),
      ...(attachments && attachments.length > 0 && { attachments }),
    };

    const data = (await hubspotRequest(
      context,
      `/conversations/v3/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'POST', body },
    )) as any;

    return formatConversationMessage(data);
  },
};
