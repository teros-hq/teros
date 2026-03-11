/**
 * Memory Module - Multi-Agent Support
 *
 * Each agent has isolated memory collections in Qdrant:
 * - agent_{agentId}_conversations
 * - agent_{agentId}_knowledge
 * - agent_{agentId}_tasks
 */

// Note: initializeOpenAI should only be imported in Node.js environments (backend/MCAs)
// DO NOT import this in React Native - it will cause bundler errors
// Use: import { initializeOpenAI } from '@teros/shared/memory/embeddings'
// Agent integration (main entry point for agents)
export {
  type AgentMemoryHook,
  type BeforeResponseOptions,
  createAgentMemoryHook,
  deleteAgentMemory,
  initializeAgentMemory,
  type MemoryStats,
  type ResponseMetadata,
  type SearchResults,
} from './agent-integration.js';
// Context retrieval for automatic injection
export {
  type ContextLimits,
  formatContextForPrompt,
  getRelevantContext,
  type RelevantContext,
} from './context.js';
// Conversation memory
export {
  getRecentConversations,
  saveConversation,
  searchConversations,
} from './conversation.js';
// Embeddings (lazy-loaded to avoid OpenAI dependency issues in React Native)
// Note: generateEmbedding is lazy-loaded and safe for all environments
export { generateEmbedding } from './embeddings-lazy.js';
// Importance calculation
export {
  calculateImportance,
  getImportanceLevel,
  getRetentionDays,
  shouldCleanup,
} from './importance.js';
// Knowledge memory
export {
  getKnowledgeByCategory,
  KNOWLEDGE_CATEGORIES,
  saveKnowledge,
  searchKnowledge,
} from './knowledge.js';
// Qdrant client and collection management
export {
  COLLECTION_TYPES,
  deleteAgentCollections,
  ensureAgentCollections,
  getAgentCollection,
  getAgentMemoryStats,
  getQdrant,
  initializeQdrant,
  listAgentsWithMemory,
  qdrant,
  VECTOR_SIZE,
} from './qdrant-client.js';
// Task memory
export {
  getRecentTasks,
  getSuccessfulTasks,
  saveTask,
  searchTasks,
} from './tasks.js';
// Memory consolidation (dreaming)
export {
  consolidateMemory,
  type ConsolidationOptions,
  type ConsolidationResult,
} from './consolidation.js';
// Knowledge extraction
export {
  extractKnowledgeFromConversation,
  type ExtractedKnowledge,
  type ExtractionResult,
} from './knowledge-extractor.js';
// Core types
export * from './types.js';
