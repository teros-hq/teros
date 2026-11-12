#!/usr/bin/env bun

/**
 * Memory MCA
 *
 * Multi-agent memory system with vector search.
 * Each agent has isolated memory collections in Qdrant.
 *
 * Thin client. This MCA no longer holds a Qdrant client nor an OpenAI key:
 * every tool forwards to a named backend action (`memory/<action>`) through
 * the authenticated callback, and the backend executes it with the shared
 * memory library against Qdrant (datastore-isolation P1b). Tool names,
 * descriptions, parameters, annotations and result shapes are unchanged —
 * McaMemoryHooks and agents see exactly the former contract.
 */

import { HealthCheckBuilder, McaServer, type ToolConfig, type ToolContext } from '@teros/mca-sdk';

const VERSION = '2.0.0';

// =============================================================================
// BACKEND ACTION CLIENT
// =============================================================================

/** Error body the backend action dispatcher answers with on failure. */
interface ActionErrorBody {
  error?: string;
  code?: string;
  suggestion?: string;
}

/**
 * Get agentId from execution context.
 * Memory is always agent-scoped, never user-scoped.
 */
function getAgentId(context: ToolContext): string {
  const { agentId } = context.execution;
  if (!agentId) {
    throw new Error('agentId is required in execution context for memory operations');
  }
  return agentId;
}

/** Optional channel context for filtering inside the agent's own memory. */
function getFilterContext(context: ToolContext): { channelId?: string } {
  const { channelId } = context.execution;
  return { channelId };
}

/**
 * Invoke `memory/<action>` with the tool args plus the agent / channel of the
 * execution context. The backend re-verifies that the agent has access to
 * this app before touching any memory. Failures surface as plain Errors
 * (the former tools threw plain Errors too), carrying the backend's message.
 */
async function invoke(context: ToolContext, action: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const backend = context.backend;
  if (!backend) {
    throw new Error('memory requires the backend callback (no callbackUrl in execution context)');
  }
  const agentId = getAgentId(context);
  const { channelId } = getFilterContext(context);
  const body: Record<string, unknown> = { ...args, agentId };
  if (channelId) body.channelId = channelId;
  try {
    return await backend.invokeAction(`memory/${action}`, body);
  } catch (error) {
    const response = (error as { response?: unknown } | null)?.response;
    if (response && typeof response === 'object') {
      const errBody = response as ActionErrorBody;
      if (typeof errBody.error === 'string') {
        throw new Error(errBody.code ? `[${errBody.code}] ${errBody.error}` : errBody.error);
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Build a tool handler that forwards its args to one action and returns the result as-is. */
function forward(action: string) {
  return async (args: Record<string, unknown>, context: ToolContext) => invoke(context, action, args);
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

const memoryHealthCheck: ToolConfig = {
  description: 'Internal health check. Verifies Qdrant connectivity and OpenAI key presence.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder()
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    const backend = context.backend;
    if (!backend) {
      builder.addIssue('DEPENDENCY_UNAVAILABLE', 'Backend callback not configured');
      return builder.build();
    }

    try {
      await backend.invokeAction('memory/ping');
    } catch (err) {
      builder.addIssue(
        'DEPENDENCY_UNAVAILABLE',
        `Backend actions unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return builder.build();
  },
};

// =============================================================================
// CONVERSATIONS
// =============================================================================

const memorySearchConversations: ToolConfig = {
  description: 'Search through conversation history using semantic search',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant conversations',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
        default: 5,
      },
    },
    required: ['query'],
  },
  handler: forward('search-conversations'),
};

const memoryGetRecentConversations: ToolConfig = {
  description: 'Get most recent conversations',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of conversations to return',
        default: 10,
      },
    },
  },
  handler: forward('recent-conversations'),
};

const memorySaveConversation: ToolConfig = {
  description: 'Save a conversation to memory with importance scoring',
  // safeWriteHint: the write is reversible (memory entries are deletable),
  // private (the agent's own memory base) and non-notifying — safe to seed
  // as 'allow' at install time instead of the mutation default 'ask'.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.0.0', stability: 'stable' },
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
  handler: forward('save-conversation'),
};

// =============================================================================
// KNOWLEDGE
// =============================================================================

const memorySaveKnowledge: ToolConfig = {
  description: 'Save a piece of knowledge to the knowledge base',
  // safeWriteHint: the write is reversible (knowledge entries are deletable),
  // private (scoped to the user's memory base) and non-notifying — safe to
  // seed as 'allow' at install time instead of the mutation default 'ask'.
  annotations: { readOnlyHint: false, safeWriteHint: true, version: '2.0.0', stability: 'stable' },
  parameters: {
    type: 'object',
    properties: {
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
    required: ['content', 'category'],
  },
  handler: forward('save-knowledge'),
};

const memorySearchKnowledge: ToolConfig = {
  description: 'Search through the knowledge base',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {
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
    required: ['query'],
  },
  handler: forward('search-knowledge'),
};

const memoryGetKnowledgeByCategory: ToolConfig = {
  description: 'Get all knowledge items in a specific category',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {
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
    },
    required: ['category'],
  },
  handler: forward('knowledge-by-category'),
};

// =============================================================================
// CONTEXT / SCORING / STATS
// =============================================================================

const memoryCalculateImportance: ToolConfig = {
  description: 'Calculate importance score for a message',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
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
  handler: forward('calculate-importance'),
};

const memoryGetContextForQuery: ToolConfig = {
  description:
    'Get relevant memory context for a user query (what would be injected into the prompt)',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "The user's query",
      },
    },
    required: ['query'],
  },
  handler: forward('context-for-query'),
};

const memoryStats: ToolConfig = {
  description: 'Get memory statistics for the current agent (collection sizes, point counts)',
  annotations: { version: '2.0.0', stability: 'stable', readOnlyHint: true },
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: forward('stats'),
};

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.memory',
  name: 'Memory',
  version: VERSION,
});

// =============================================================================
// REGISTER MEMORY TOOLS
// =============================================================================

server.tool('memory-health-check', memoryHealthCheck);
server.tool('memory-search-conversations', memorySearchConversations);
server.tool('memory-get-recent-conversations', memoryGetRecentConversations);
server.tool('memory-save-conversation', memorySaveConversation);
server.tool('memory-save-knowledge', memorySaveKnowledge);
server.tool('memory-search-knowledge', memorySearchKnowledge);
server.tool('memory-get-knowledge-by-category', memoryGetKnowledgeByCategory);
server.tool('memory-calculate-importance', memoryCalculateImportance);
server.tool('memory-get-context-for-query', memoryGetContextForQuery);
server.tool('memory-stats', memoryStats);

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Memory MCA] Fatal error:', error);
  process.exit(1);
});
