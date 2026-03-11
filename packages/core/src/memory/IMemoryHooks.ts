/**
 * Memory Hooks Interface
 *
 * Defines hooks that can be injected into ConversationManager
 * to provide memory-aware context enrichment and learning.
 *
 * SOLID Principles:
 * - Interface Segregation: Small, focused interface
 * - Dependency Inversion: ConversationManager depends on abstraction, not implementation
 * - Single Responsibility: Each hook has one clear purpose
 */

export interface ResponseMetadata {
  /**
   * Files that were modified during this interaction
   */
  filesModified?: string[];

  /**
   * Commands that were executed
   */
  commandsRun?: string[];

  /**
   * Tools that were called
   */
  toolsCalled?: string[];

  /**
   * Outcome of the task (if applicable)
   */
  taskOutcome?: 'success' | 'failure' | 'partial';

  /**
   * Conversation context identifier
   */
  context?: string;

  /**
   * Pre-calculated importance score (0.0-1.0)
   */
  importance?: number;

  /**
   * Session ID for grouping related interactions
   */
  sessionId?: string;
}

/**
 * Memory Hooks - Lifecycle hooks for memory integration
 *
 * These hooks allow the ConversationManager to:
 * 1. Enrich prompts with relevant context (beforeResponse)
 * 2. Learn from interactions (afterResponse)
 *
 * Implementation can be:
 * - QdrantMemoryHooks (production)
 * - NoOpMemoryHooks (testing)
 * - CustomMemoryHooks (user-defined)
 */
export interface IMemoryHooks {
  /**
   * Called BEFORE generating a response
   *
   * Purpose: Provide relevant context from memory to enrich the LLM prompt
   *
   * Strategy (as per Pablo's requirement):
   * - Search ONLY in knowledge base (NOT raw conversations)
   * - Search ONLY in tasks (NOT raw conversations)
   * - Raw conversations are stored but NOT used for context
   *
   * @param userMessage - The user's message
   * @returns Context string to inject into system prompt (empty if none)
   */
  beforeResponse(userMessage: string): Promise<string>;

  /**
   * Called AFTER generating a response
   *
   * Purpose: Learn from the interaction by:
   * 1. Storing the raw conversation (for dreaming/analysis only)
   * 2. Extracting knowledge (THIS is used for future context)
   * 3. Extracting tasks (THIS is used for future context)
   *
   * @param userMessage - The user's message
   * @param assistantResponse - The assistant's response
   * @param metadata - Optional metadata about the interaction
   */
  afterResponse(
    userMessage: string,
    assistantResponse: string,
    metadata?: ResponseMetadata,
  ): Promise<void>;
}

/**
 * No-op implementation for when memory is disabled
 *
 * Follows Null Object Pattern - safe to call without side effects
 */
export class NoOpMemoryHooks implements IMemoryHooks {
  async beforeResponse(_userMessage: string): Promise<string> {
    return '';
  }

  async afterResponse(
    _userMessage: string,
    _assistantResponse: string,
    _metadata?: ResponseMetadata,
  ): Promise<void> {
    // No-op
  }
}
