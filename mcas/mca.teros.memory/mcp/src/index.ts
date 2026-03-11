#!/usr/bin/env npx tsx

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { createAgentMemoryHook, initializeAgentMemory, deleteAgentMemory } from '../../../memory/agent-integration.js';
import { saveConversation, searchConversations, getRecentConversations } from '../../../memory/conversation.js';
import { calculateImportance } from '../../../memory/importance.js';
import {
  getKnowledgeByCategory,
  saveKnowledge,
  searchKnowledge,
} from '../../../memory/knowledge.js';
import {
  listAgentsWithMemory,
  getAgentMemoryStats,
} from '../../../memory/qdrant-client.js';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

if (!QDRANT_API_KEY) {
  console.error('Missing QDRANT_API_KEY environment variable');
  process.exit(1);
}

// Initialize Qdrant client for direct operations
const qdrantClient = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

// Cache for agent memory hooks
const agentHooks = new Map<string, ReturnType<typeof createAgentMemoryHook>>();

function getAgentHook(agentId: string) {
  if (!agentHooks.has(agentId)) {
    agentHooks.set(agentId, createAgentMemoryHook(agentId));
  }
  return agentHooks.get(agentId)!;
}

const server = new Server(
  {
    name: 'mca.teros.memory',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Agent memory management
      {
        name: 'memory_init_agent',
        description: 'Initialize memory collections for an agent. Must be called before using memory for a new agent.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Unique identifier for the agent',
            },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'memory_delete_agent',
        description: 'Delete all memory collections for an agent. This is irreversible!',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID whose memory to delete',
            },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'memory_list_agents',
        description: 'List all agents that have memory collections',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'memory_agent_stats',
        description: 'Get memory statistics for an agent (collection sizes, point counts)',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID to get stats for',
            },
          },
          required: ['agentId'],
        },
      },
      // Conversation memory
      {
        name: 'memory_search_conversations',
        description: 'Search through conversation history using semantic search',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID whose conversations to search',
            },
            query: {
              type: 'string',
              description: 'Search query to find relevant conversations',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 5,
            },
            context: {
              type: 'string',
              description: "Optional context filter (e.g., 'telegram-12345')",
            },
          },
          required: ['agentId', 'query'],
        },
      },
      {
        name: 'memory_get_recent_conversations',
        description: 'Get most recent conversations for an agent',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of conversations to return',
              default: 10,
            },
            context: {
              type: 'string',
              description: 'Optional context filter',
            },
          },
          required: ['agentId'],
        },
      },
      {
        name: 'memory_save_conversation',
        description: 'Save a conversation to memory with importance scoring',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID to save conversation for',
            },
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
            context: {
              type: 'string',
              description: "Context identifier (e.g., 'telegram-12345')",
            },
            userId: {
              type: 'string',
              description: 'User ID associated with the conversation',
            },
            channelId: {
              type: 'string',
              description: 'Channel ID where the conversation occurred',
            },
          },
          required: ['agentId', 'userMessage', 'assistantResponse'],
        },
      },
      // Knowledge base
      {
        name: 'memory_save_knowledge',
        description: 'Save a piece of knowledge to the knowledge base',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID to save knowledge for',
            },
            content: {
              type: 'string',
              description: 'The knowledge content to save',
            },
            category: {
              type: 'string',
              enum: [
                'user_preferences',
                'project_data',
                'commands',
                'coding_patterns',
                'tools',
                'workflows',
              ],
              description: 'Category of knowledge',
            },
            confidence: {
              type: 'number',
              description: 'Confidence score (0-1)',
              default: 0.8,
            },
          },
          required: ['agentId', 'content', 'category'],
        },
      },
      {
        name: 'memory_search_knowledge',
        description: 'Search through the knowledge base',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID whose knowledge to search',
            },
            query: {
              type: 'string',
              description: 'Search query',
            },
            category: {
              type: 'string',
              enum: [
                'user_preferences',
                'project_data',
                'commands',
                'coding_patterns',
                'tools',
                'workflows',
              ],
              description: 'Optional category filter',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results',
              default: 5,
            },
          },
          required: ['agentId', 'query'],
        },
      },
      {
        name: 'memory_get_knowledge_by_category',
        description: 'Get all knowledge items in a specific category',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID',
            },
            category: {
              type: 'string',
              enum: [
                'user_preferences',
                'project_data',
                'commands',
                'coding_patterns',
                'tools',
                'workflows',
              ],
              description: 'Knowledge category',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results',
              default: 20,
            },
          },
          required: ['agentId', 'category'],
        },
      },
      // Utility tools
      {
        name: 'memory_calculate_importance',
        description: 'Calculate importance score for a message',
        inputSchema: {
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
      },
      {
        name: 'memory_get_context_for_query',
        description:
          'Get relevant memory context for a user query (what would be injected into the prompt)',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: 'Agent ID',
            },
            query: {
              type: 'string',
              description: "The user's query",
            },
          },
          required: ['agentId', 'query'],
        },
      },
      // Qdrant direct access tools
      {
        name: 'qdrant_list_collections',
        description: 'List all collections in Qdrant',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'qdrant_create_collection',
        description: 'Create a new collection in Qdrant',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the collection',
            },
            vectorSize: {
              type: 'number',
              description: 'Size of the vectors (e.g., 1536 for OpenAI embeddings)',
            },
            distance: {
              type: 'string',
              enum: ['Cosine', 'Euclid', 'Dot'],
              description: 'Distance metric to use',
              default: 'Cosine',
            },
          },
          required: ['name', 'vectorSize'],
        },
      },
      {
        name: 'qdrant_delete_collection',
        description: 'Delete a collection from Qdrant',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the collection to delete',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'qdrant_get_collection_info',
        description: 'Get information about a specific collection',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name of the collection',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'qdrant_upsert_points',
        description: 'Insert or update points (vectors with payloads) in a collection',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the collection',
            },
            points: {
              type: 'array',
              description: 'Array of points to upsert',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: ['string', 'number'],
                    description: 'Unique ID for the point',
                  },
                  vector: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'Vector embedding',
                  },
                  payload: {
                    type: 'object',
                    description: 'Metadata associated with the vector',
                  },
                },
                required: ['id', 'vector'],
              },
            },
          },
          required: ['collection', 'points'],
        },
      },
      {
        name: 'qdrant_search',
        description: 'Search for similar vectors in a collection',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the collection',
            },
            vector: {
              type: 'array',
              items: { type: 'number' },
              description: 'Query vector',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return',
              default: 10,
            },
            filter: {
              type: 'object',
              description: 'Optional filter conditions',
            },
          },
          required: ['collection', 'vector'],
        },
      },
      {
        name: 'qdrant_scroll_points',
        description: 'Retrieve points from a collection with optional filtering',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the collection',
            },
            limit: {
              type: 'number',
              description: 'Number of points to retrieve',
              default: 10,
            },
            filter: {
              type: 'object',
              description: 'Optional filter conditions',
            },
            offset: {
              type: ['string', 'number'],
              description: 'Offset for pagination',
            },
          },
          required: ['collection'],
        },
      },
      {
        name: 'qdrant_delete_points',
        description: 'Delete points from a collection by IDs or filter',
        inputSchema: {
          type: 'object',
          properties: {
            collection: {
              type: 'string',
              description: 'Name of the collection',
            },
            points: {
              type: 'array',
              items: { type: ['string', 'number'] },
              description: 'Array of point IDs to delete',
            },
            filter: {
              type: 'object',
              description: 'Optional filter to select points to delete',
            },
          },
          required: ['collection'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`[MCA Memory] Tool called: ${name}`);
  console.error(`[MCA Memory] Arguments:`, JSON.stringify(args, null, 2));

  try {
    // Agent memory management
    if (name === 'memory_init_agent') {
      const { agentId } = args as { agentId: string };
      await initializeAgentMemory(agentId);
      return {
        content: [
          {
            type: 'text',
            text: `Memory collections initialized for agent "${agentId}"`,
          },
        ],
      };
    }

    if (name === 'memory_delete_agent') {
      const { agentId } = args as { agentId: string };
      await deleteAgentMemory(agentId);
      agentHooks.delete(agentId); // Clear cached hook
      return {
        content: [
          {
            type: 'text',
            text: `All memory collections deleted for agent "${agentId}"`,
          },
        ],
      };
    }

    if (name === 'memory_list_agents') {
      const agents = await listAgentsWithMemory();
      return {
        content: [
          {
            type: 'text',
            text: agents.length > 0
              ? `Agents with memory:\n${agents.map(a => `- ${a}`).join('\n')}`
              : 'No agents with memory found',
          },
        ],
      };
    }

    if (name === 'memory_agent_stats') {
      const { agentId } = args as { agentId: string };
      const stats = await getAgentMemoryStats(agentId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    // Conversation memory
    if (name === 'memory_search_conversations') {
      const {
        agentId,
        query,
        limit = 5,
        context,
      } = args as {
        agentId: string;
        query: string;
        limit?: number;
        context?: string;
      };

      const results = await searchConversations(agentId, query, limit, context ? { channelId: context } : undefined);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === 'memory_get_recent_conversations') {
      const {
        agentId,
        limit = 10,
        context,
      } = args as {
        agentId: string;
        limit?: number;
        context?: string;
      };

      const results = await getRecentConversations(agentId, limit, context ? { channelId: context } : undefined);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === 'memory_save_conversation') {
      const {
        agentId,
        userMessage,
        assistantResponse,
        filesModified = [],
        commandsRun = [],
        context,
        userId,
        channelId,
      } = args as {
        agentId: string;
        userMessage: string;
        assistantResponse: string;
        filesModified?: string[];
        commandsRun?: string[];
        context?: string;
        userId?: string;
        channelId?: string;
      };

      const importance = calculateImportance({
        userMessage,
        assistantResponse,
        filesModified,
        commandsRun,
      });

      await saveConversation(userMessage, assistantResponse, {
        agentId,
        importance,
        context,
        userId,
        channelId,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Conversation saved successfully with importance score: ${importance.toFixed(2)}`,
          },
        ],
      };
    }

    // Knowledge base
    if (name === 'memory_save_knowledge') {
      const {
        agentId,
        content,
        category,
        confidence = 0.8,
      } = args as {
        agentId: string;
        content: string;
        category: string;
        confidence?: number;
      };

      const id = await saveKnowledge(agentId, content, 'mca-tool', category, { confidence });

      return {
        content: [
          {
            type: 'text',
            text: `Knowledge saved successfully with ID: ${id}`,
          },
        ],
      };
    }

    if (name === 'memory_search_knowledge') {
      const {
        agentId,
        query,
        category,
        limit = 5,
      } = args as {
        agentId: string;
        query: string;
        category?: string;
        limit?: number;
      };

      const results = await searchKnowledge(agentId, query, limit, category);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    if (name === 'memory_get_knowledge_by_category') {
      const { agentId, category, limit = 20 } = args as {
        agentId: string;
        category: string;
        limit?: number;
      };

      // Note: limit is not used yet by getKnowledgeByCategory
      const results = await getKnowledgeByCategory(agentId, category);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    // Utility tools
    if (name === 'memory_calculate_importance') {
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
        content: [
          {
            type: 'text',
            text: `Importance score: ${importance.toFixed(2)}\n\nBreakdown:\n- Message length: ${userMessage.length} chars\n- Response length: ${assistantResponse.length} chars\n- Files modified: ${filesModified.length}\n- Commands run: ${commandsRun.length}`,
          },
        ],
      };
    }

    if (name === 'memory_get_context_for_query') {
      const { agentId, query } = args as { agentId: string; query: string };

      const hook = getAgentHook(agentId);
      const context = await hook.beforeResponse(query);

      return {
        content: [
          {
            type: 'text',
            text: context || 'No relevant context found in memory',
          },
        ],
      };
    }

    // Qdrant direct access tools
    if (name === 'qdrant_list_collections') {
      const result = await qdrantClient.getCollections();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.collections, null, 2),
          },
        ],
      };
    }

    if (name === 'qdrant_create_collection') {
      const {
        name: collectionName,
        vectorSize,
        distance = 'Cosine',
      } = args as {
        name: string;
        vectorSize: number;
        distance?: 'Cosine' | 'Euclid' | 'Dot';
      };

      await qdrantClient.createCollection(collectionName, {
        vectors: {
          size: vectorSize,
          distance,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: `Collection "${collectionName}" created successfully with vector size ${vectorSize} and distance metric ${distance}`,
          },
        ],
      };
    }

    if (name === 'qdrant_delete_collection') {
      const { name: collectionName } = args as { name: string };
      await qdrantClient.deleteCollection(collectionName);

      return {
        content: [
          {
            type: 'text',
            text: `Collection "${collectionName}" deleted successfully`,
          },
        ],
      };
    }

    if (name === 'qdrant_get_collection_info') {
      const { name: collectionName } = args as { name: string };
      const result = await qdrantClient.getCollection(collectionName);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'qdrant_upsert_points') {
      const { collection, points } = args as {
        collection: string;
        points: Array<{
          id: string | number;
          vector: number[];
          payload?: Record<string, any>;
        }>;
      };

      await qdrantClient.upsert(collection, {
        wait: true,
        points,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Successfully upserted ${points.length} points to collection "${collection}"`,
          },
        ],
      };
    }

    if (name === 'qdrant_search') {
      const {
        collection,
        vector,
        limit = 10,
        filter,
      } = args as {
        collection: string;
        vector: number[];
        limit?: number;
        filter?: any;
      };

      const result = await qdrantClient.search(collection, {
        vector,
        limit,
        filter,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'qdrant_scroll_points') {
      const {
        collection,
        limit = 10,
        filter,
        offset,
      } = args as {
        collection: string;
        limit?: number;
        filter?: any;
        offset?: string | number;
      };

      const result = await qdrantClient.scroll(collection, {
        limit,
        filter,
        offset,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'qdrant_delete_points') {
      const { collection, points, filter } = args as {
        collection: string;
        points?: Array<string | number>;
        filter?: any;
      };

      if (points && points.length > 0) {
        await qdrantClient.delete(collection, {
          wait: true,
          points,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted ${points.length} points from collection "${collection}"`,
            },
          ],
        };
      }

      if (filter) {
        await qdrantClient.delete(collection, {
          wait: true,
          filter,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Deleted points matching filter from collection "${collection}"`,
            },
          ],
        };
      }

      throw new Error('Either points or filter must be provided');
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Teros Memory MCA server running (Multi-agent Memory + Qdrant)');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
