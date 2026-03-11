#!/usr/bin/env bun

/**
 * Memory MCA
 *
 * Multi-agent memory system with vector search.
 * Each agent has isolated memory collections in Qdrant.
 */

import { McaServer } from '@teros/mca-sdk';
import {
  memorySearchConversations,
  memoryGetRecentConversations,
  memorySaveConversation,
  memorySaveKnowledge,
  memorySearchKnowledge,
  memoryGetKnowledgeByCategory,
  memoryCalculateImportance,
  memoryGetContextForQuery,
  memoryStats,
} from './tools';

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.memory',
  name: 'Memory',
  version: '2.0.0',
});

// =============================================================================
// REGISTER MEMORY TOOLS
// =============================================================================

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
