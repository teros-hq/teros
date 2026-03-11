import type { HttpToolConfig } from '@teros/mca-sdk';
import { calculateImportance } from '@teros/shared/memory/importance';
import { ensureQdrantInitialized } from '../qdrant-init';

export const memoryCalculateImportance: HttpToolConfig = {
  description: 'Calculate importance score for a message',
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
        description: 'List of files modified',
        default: [],
      },
      commandsRun: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of commands run',
        default: [],
      },
    },
    required: ['userMessage', 'assistantResponse'],
  },
  handler: async (args, _context) => {
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

    const importance = calculateImportance({
      userMessage,
      assistantResponse,
      filesModified,
      commandsRun,
    });

    return {
      success: true,
      importance,
      breakdown: {
        messageLength: userMessage.length,
        responseLength: assistantResponse.length,
        filesModified: filesModified.length,
        commandsRun: commandsRun.length,
      },
    };
  },
};
