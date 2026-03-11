import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createKelifyClient, type KelifyClient } from '../src/index.js';

let kelifyClient: KelifyClient | null = null;

function getClient(): KelifyClient {
  if (!kelifyClient) {
    const apiKey = process.env.KELIFY_API_KEY;
    if (!apiKey) {
      throw new Error('KELIFY_API_KEY environment variable is required');
    }

    const baseUrl = process.env.KELIFY_API_BASE_URL;
    kelifyClient = createKelifyClient({ apiKey, baseUrl });
  }
  return kelifyClient;
}

export const kelifyCreateConversationTool: Tool = {
  name: 'kelify_create_conversation',
  description:
    'Create a new conversation session for property search. Each conversation maintains context across multiple messages, allowing for natural follow-up questions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export async function handleKelifyCreateConversation(args: any): Promise<any> {
  try {
    const client = getClient();
    const result = await client.createConversation();

    return {
      success: true,
      conversation_id: result.conversation_id,
      created_at: result.created_at,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export const kelifySendMessageTool: Tool = {
  name: 'kelify_send_message',
  description:
    'Send a user message to a conversation and receive an AI response with property search results. Can use streaming or non-streaming mode.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation UUID to send the message to',
      },
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: "The user's message to the AI assistant for property search",
      },
      stream: {
        type: 'boolean',
        description: 'Whether to stream the response. Default is true.',
      },
    },
    required: ['conversation_id', 'message'],
  },
};

export async function handleKelifySendMessage(args: any): Promise<any> {
  try {
    const { conversation_id, message, stream = true } = args;
    const client = getClient();

    if (stream) {
      const accumulatedChunks: string[] = [];
      let searchResults: any = null;
      let finalResponse: any = null;

      await client.sendMessageStream(
        conversation_id,
        message,
        (delta) => {
          accumulatedChunks.push(delta);
        },
        (results) => {
          searchResults = results;
        },
      );

      finalResponse = await client.sendMessage(conversation_id, message, false);

      return {
        success: true,
        conversation_id: finalResponse.conversation_id,
        title: finalResponse.title,
        message: finalResponse.message,
        search_results: finalResponse.search_results,
        usage: finalResponse.usage,
      };
    } else {
      const result = await client.sendMessage(conversation_id, message, false);

      return {
        success: true,
        conversation_id: result.conversation_id,
        title: result.title,
        message: result.message,
        search_results: result.search_results,
        usage: result.usage,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export const kelifyGetConversationTool: Tool = {
  name: 'kelify_get_conversation',
  description:
    'Retrieve full conversation history including all messages, AI responses, search results, and usage statistics.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: {
        type: 'string',
        description: 'The conversation UUID to retrieve',
      },
    },
    required: ['conversation_id'],
  },
};

export async function handleKelifyGetConversation(args: any): Promise<any> {
  try {
    const { conversation_id } = args;
    const client = getClient();
    const result = await client.getConversation(conversation_id);

    return {
      success: true,
      conversation_id: result.conversation_id,
      created_at: result.created_at,
      updated_at: result.updated_at,
      title: result.title,
      messages: result.messages,
      usage: result.usage,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
}

export const kelifyTools = [
  {
    tool: kelifyCreateConversationTool,
    handler: handleKelifyCreateConversation,
  },
  {
    tool: kelifySendMessageTool,
    handler: handleKelifySendMessage,
  },
  {
    tool: kelifyGetConversationTool,
    handler: handleKelifyGetConversation,
  },
];
