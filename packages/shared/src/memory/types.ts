/**
 * Memory Types
 * 
 * All memory entries include agentId to support multi-agent environments.
 * Each agent has its own isolated memory space.
 */

export interface ConversationMemory {
  id: string;
  timestamp: string;
  user_message: string;
  assistant_response: string;
  context?: string;
  importance: number;
  // Multi-agent support
  agentId: string;        // Required: which agent owns this memory
  userId?: string;        // Optional: which user was interacting
  sessionId?: string;     // Optional: conversation session
  channelId?: string;     // Optional: Teros channel ID
  [key: string]: unknown; // Allow Qdrant compatibility
}

export interface KnowledgeMemory {
  id: string;
  fact: string;
  source: string;
  category: string;
  confidence: number;
  timestamp: string;
  last_accessed?: string;
  // Multi-agent support
  agentId: string;        // Required: which agent owns this knowledge
  userId?: string;        // Optional: learned from which user
  [key: string]: unknown; // Allow Qdrant compatibility
}

export interface TaskMemory {
  id: string;
  description: string;
  files_modified: string[];
  commands_run: string[];
  outcome: 'success' | 'failure' | 'partial';
  lessons_learned?: string;
  timestamp: string;
  duration_ms?: number;
  // Multi-agent support
  agentId: string;        // Required: which agent performed this task
  userId?: string;        // Optional: for which user
  [key: string]: unknown; // Allow Qdrant compatibility
}

export interface SearchResult<T> {
  id: string | number;
  score: number;
  payload: T;
}

/**
 * Options for memory operations
 */
export interface MemoryContext {
  agentId: string;        // Required: agent performing the operation
  userId?: string;        // Optional: user context
  sessionId?: string;     // Optional: session context
  channelId?: string;     // Optional: channel context
}

/**
 * Filter for searching memories
 * If agentId is provided, only that agent's memories are searched
 * If not provided, searches across all agents (admin use case)
 */
export interface MemoryFilter {
  agentId?: string;
  userId?: string;
  channelId?: string;
  minImportance?: number;
  since?: string;         // ISO timestamp
}
