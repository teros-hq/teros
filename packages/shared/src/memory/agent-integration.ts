/**
 * Agent Memory Integration
 * 
 * Provides hooks for agents to interact with their personal memory.
 * Each agent has isolated collections in Qdrant.
 */

import { searchConversations } from './conversation.js';
import { searchKnowledge } from './knowledge.js';
import { searchTasks } from './tasks.js';
import { saveConversation } from './conversation.js';
import { calculateImportance, getImportanceLevel, getRetentionDays, shouldCleanup } from './importance.js';
import { getAgentMemoryStats, ensureAgentCollections, deleteAgentCollections } from './qdrant-client.js';
import { logger } from './logger.js';

/**
 * Memory hook for an agent
 * Created once per agent, reused across conversations
 */
export interface AgentMemoryHook {
  /** Get relevant context before responding to a user message */
  beforeResponse: (userMessage: string, options?: BeforeResponseOptions) => Promise<string>;
  /** Save conversation to memory after responding */
  afterResponse: (userMessage: string, assistantResponse: string, metadata?: ResponseMetadata) => Promise<void>;
  /** Quick search across all memory types */
  search: (query: string, limit?: number) => Promise<SearchResults>;
  /** Get memory statistics */
  getStats: () => Promise<MemoryStats>;
}

export interface BeforeResponseOptions {
  userId?: string;
  channelId?: string;
  conversationLimit?: number;
  knowledgeLimit?: number;
  taskLimit?: number;
  minRelevance?: number;
}

export interface ResponseMetadata {
  filesModified?: string[];
  commandsRun?: string[];
  taskOutcome?: 'success' | 'failure' | 'partial';
  extractedKnowledge?: Array<{ fact: string; category: string; confidence: number }>;
  userId?: string;
  channelId?: string;
  sessionId?: string;
  importance?: number;
}

export interface SearchResults {
  conversations: Array<{
    user: string;
    assistant: string;
    score: number;
    timestamp: string;
  }>;
  knowledge: Array<{
    fact: string;
    category: string;
    confidence: number;
    score: number;
  }>;
  tasks: Array<{
    description: string;
    outcome: string;
    files: string[];
    score: number;
  }>;
}

export interface MemoryStats {
  conversations: number;
  knowledge: number;
  tasks: number;
  totalPoints: number;
}

/**
 * Create a memory hook for a specific agent
 * Each agent has its own isolated memory collections
 */
export function createAgentMemoryHook(agentId: string): AgentMemoryHook {
  if (!agentId) {
    throw new Error('agentId is required to create memory hook');
  }

  logger.info(`🧠 Creating memory hook for agent: ${agentId}`);

  return {
    async beforeResponse(
      userMessage: string,
      options: BeforeResponseOptions = {}
    ): Promise<string> {
      const {
        userId,
        channelId,
        conversationLimit = 2,
        knowledgeLimit = 3,
        taskLimit = 2,
        minRelevance = 0.3,
      } = options;

      // Search in parallel across all memory types
      const [conversations, knowledge, tasks] = await Promise.all([
        searchConversations(agentId, userMessage, conversationLimit, { userId, channelId }),
        searchKnowledge(agentId, userMessage, knowledgeLimit),
        searchTasks(agentId, userMessage, taskLimit),
      ]);

      // Filter by minimum relevance
      const relevantConversations = conversations.filter(c => c.score >= minRelevance);
      const relevantKnowledge = knowledge.filter(k => k.score >= minRelevance);
      const relevantTasks = tasks.filter(t => t.score >= minRelevance);

      if (
        relevantConversations.length === 0 &&
        relevantKnowledge.length === 0 &&
        relevantTasks.length === 0
      ) {
        return '';
      }

      // Log relevance scores
      logger.debug(`🧠 [${agentId}] Context Relevance Scores:`);
      if (relevantConversations.length > 0) {
        const scores = relevantConversations.map((c) => c.score.toFixed(2)).join(', ');
        logger.debug(`  💬 Conversations (${relevantConversations.length}): ${scores}`);
      }
      if (relevantKnowledge.length > 0) {
        const scores = relevantKnowledge.map((k) => k.score.toFixed(2)).join(', ');
        logger.debug(`  📚 Knowledge (${relevantKnowledge.length}): ${scores}`);
      }
      if (relevantTasks.length > 0) {
        const scores = relevantTasks.map((t) => t.score.toFixed(2)).join(', ');
        logger.debug(`  ✅ Tasks (${relevantTasks.length}): ${scores}`);
      }

      // Format context for prompt injection
      const formattedContext = formatContextForPrompt({
        conversations: relevantConversations,
        knowledge: relevantKnowledge,
        tasks: relevantTasks,
      });

      logger.debug(`  📏 [${agentId}] Context length: ${formattedContext.length} chars`);
      return formattedContext;
    },

    async afterResponse(
      userMessage: string,
      assistantResponse: string,
      metadata: ResponseMetadata = {}
    ): Promise<void> {
      const importance = metadata.importance ?? calculateImportance({
        userMessage,
        assistantResponse,
        filesModified: metadata.filesModified || [],
        commandsRun: metadata.commandsRun || [],
      });

      // Only save if importance is above threshold
      if (importance < 0.2) {
        logger.debug(`⏭️ [${agentId}] Skipping low-importance conversation (${importance.toFixed(2)})`);
        return;
      }

      await saveConversation(userMessage, assistantResponse, {
        agentId,
        userId: metadata.userId,
        sessionId: metadata.sessionId,
        channelId: metadata.channelId,
        importance,
      });

      logger.debug(`💾 [${agentId}] Saved conversation with importance ${importance.toFixed(2)}`);
    },

    async search(query: string, limit: number = 5): Promise<SearchResults> {
      const [conversations, knowledge, tasks] = await Promise.all([
        searchConversations(agentId, query, limit),
        searchKnowledge(agentId, query, limit),
        searchTasks(agentId, query, limit),
      ]);

      return {
        conversations: conversations.map((r) => ({
          user: r.payload.user_message,
          assistant: r.payload.assistant_response,
          score: r.score,
          timestamp: r.payload.timestamp,
        })),
        knowledge: knowledge.map((r) => ({
          fact: r.payload.fact,
          category: r.payload.category,
          confidence: r.payload.confidence,
          score: r.score,
        })),
        tasks: tasks.map((r) => ({
          description: r.payload.description,
          outcome: r.payload.outcome,
          files: r.payload.files_modified,
          score: r.score,
        })),
      };
    },

    async getStats(): Promise<MemoryStats> {
      return getAgentMemoryStats(agentId);
    },
  };
}

/**
 * Format memory context for injection into agent prompt
 */
function formatContextForPrompt(context: {
  conversations: any[];
  knowledge: any[];
  tasks: any[];
}): string {
  const sections: string[] = [];

  if (context.conversations.length > 0) {
    const convSection = context.conversations
      .map((c) => `- User: "${c.payload.user_message.slice(0, 100)}..." → You responded about ${c.payload.assistant_response.slice(0, 50)}...`)
      .join('\n');
    sections.push(`**Relevant past conversations:**\n${convSection}`);
  }

  if (context.knowledge.length > 0) {
    const knowledgeSection = context.knowledge
      .map((k) => `- [${k.payload.category}] ${k.payload.fact}`)
      .join('\n');
    sections.push(`**Relevant knowledge:**\n${knowledgeSection}`);
  }

  if (context.tasks.length > 0) {
    const taskSection = context.tasks
      .map((t) => `- ${t.payload.description} (${t.payload.outcome})`)
      .join('\n');
    sections.push(`**Relevant past tasks:**\n${taskSection}`);
  }

  return sections.join('\n\n');
}

/**
 * Initialize memory for an agent (creates collections if needed)
 */
export async function initializeAgentMemory(agentId: string): Promise<void> {
  await ensureAgentCollections(agentId);
  logger.info(`✅ [${agentId}] Memory initialized`);
}

/**
 * Delete all memory for an agent
 */
export async function deleteAgentMemory(agentId: string): Promise<void> {
  await deleteAgentCollections(agentId);
  logger.info(`🗑️ [${agentId}] Memory deleted`);
}

// Re-export utilities
export { calculateImportance, getImportanceLevel, getRetentionDays, shouldCleanup };
export { getAgentMemoryStats };
