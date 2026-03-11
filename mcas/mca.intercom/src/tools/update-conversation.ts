import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { intercomRequest } from '../lib';

export const updateConversation: ToolConfig = {
  description:
    'Update a conversation state (open, close, snooze) or priority in Intercom.',
  parameters: {
    type: 'object',
    properties: {
      conversationId: {
        type: 'string',
        description: 'The Intercom conversation ID',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'snoozed'],
        description: 'New state for the conversation',
      },
      priority: {
        type: 'string',
        enum: ['priority', 'not_priority'],
        description: 'Set or unset priority flag',
      },
      snoozedUntil: {
        type: 'number',
        description: 'Unix timestamp — required when state is "snoozed"',
      },
    },
    required: ['conversationId'],
  },
  handler: async (args, context) => {
    const { conversationId, state, priority, snoozedUntil } = args as {
      conversationId: string;
      state?: string;
      priority?: string;
      snoozedUntil?: number;
    };

    const body: Record<string, unknown> = {};
    if (state) body.state = state;
    if (priority) body.priority = priority;
    if (snoozedUntil) body.snoozed_until = snoozedUntil;

    return intercomRequest(context, `/conversations/${conversationId}`, {
      method: 'PUT',
      body,
    });
  },
};
