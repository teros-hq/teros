import type { HttpToolConfig } from '@teros/mca-sdk';
import { getAgentId, getFilterContext } from '../lib';
import { ensureQdrantInitialized } from '../qdrant-init';
import { saveConversation } from '@teros/shared/memory/conversation';
import { calculateImportance } from '@teros/shared/memory/importance';

export const memorySaveConversation: HttpToolConfig = {
  description: 'Save a conversation to memory with importance scoring',
  parameters: {
    type: 'object',
    properties: {
      userMessage: {
        type: 'string',
        description: "The user's message",
      },
      assistantResponse: {
        type: 'string',
        description: "The assistant's response",
      },
      filesModified: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of files that were modified',
        default: [],
      },
      commandsRun: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of commands that were executed',
        default: [],
      },
    },
    required: ['userMessage', 'assistantResponse'],
  },
  handler: async (args, context) => {
    await ensureQdrantInitialized(context);
    const {
      userMessage,
      assistantResponse,
      filesModified = [],
      commandsRun = [],
    } = args as {
      userMessage: string;
      assistantResponse: string;
      filesModified?: string[];
      commandsRun?: string[];
    };

    const agentId = getAgentId(context);
    const { userId, channelId } = getFilterContext(context);

    const importance = calculateImportance({
      userMessage,
      assistantResponse,
      filesModified,
      commandsRun,
    });

    await saveConversation(userMessage, assistantResponse, {
      agentId,
      importance,
      userId,
      channelId,
    });

    return {
      success: true,
      message: `Conversation saved with importance score: ${importance.toFixed(2)}`,
      importance,
    };
  },
};
