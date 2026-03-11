/**
 * Memory System Types
 *
 * Mirrors the types from the main memory system
 */

export interface ConversationMemory {
  id: string;
  timestamp: string;
  user_message: string;
  assistant_response: string;
  context?: string;
  importance: number;
  session_id?: string;
}

export interface KnowledgeMemory {
  id: string;
  fact: string;
  source: string;
  category: string;
  confidence: number;
  timestamp: string;
  last_accessed?: string;
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
}

export interface SearchResult<T> {
  id: string | number;
  score: number;
  payload: T;
}

export interface MemoryStats {
  conversations: {
    total: number;
    last24h: number;
    last7days: number;
    avgImportance: number;
  };
  knowledge: {
    total: number;
    categories: Map<string, number>;
    avgConfidence: number;
  };
  tasks: {
    total: number;
    successful: number;
    failed: number;
    partial: number;
    last24h: number;
  };
}
