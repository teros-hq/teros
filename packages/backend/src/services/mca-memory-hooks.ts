/**
 * MCA Memory Hooks
 * 
 * Implementation of IMemoryHooks that uses the Memory MCA via McaToolExecutor
 * to provide context enrichment and learning.
 */

import type { IMemoryHooks, ResponseMetadata } from '@teros/core';
import type { McaToolExecutor } from './mca-tool-executor';

export class McaMemoryHooks implements IMemoryHooks {
  constructor(
    private toolExecutor: McaToolExecutor,
    private agentId: string,
  ) {}

  /**
   * Get memory context before generating response
   * Uses the memory_memory-get-context-for-query tool with bypassPermissions
   */
  async beforeResponse(userMessage: string): Promise<string> {
    try {
      console.log(`[McaMemoryHooks] 🔍 Fetching memory context for agent ${this.agentId}`);

      const result = await this.toolExecutor.executeTool(
        'memory_memory-get-context-for-query',
        { query: userMessage },
        { bypassPermissions: true },
      );

      if (result.isError) {
        console.warn(`[McaMemoryHooks] ❌ Memory context returned error: ${result.output}`);
        return '';
      }

      // Parse the JSON output
      try {
        const parsed = JSON.parse(result.output);
        
        if (parsed.success && parsed.context && typeof parsed.context === 'string') {
          console.log(`[McaMemoryHooks] ✅ Retrieved ${parsed.context.length} chars of memory context`);
          return parsed.context;
        }
      } catch (parseError) {
        console.warn('[McaMemoryHooks] ❌ Failed to parse memory context output:', parseError);
      }

      return '';
    } catch (error) {
      console.warn(`[McaMemoryHooks] ❌ Failed to get memory context:`, error);
      return '';
    }
  }

  /**
   * Save conversation to memory after generating response
   * Uses the memory_memory-save-conversation tool with bypassPermissions
   */
  async afterResponse(
    userMessage: string,
    assistantResponse: string,
    metadata?: ResponseMetadata,
  ): Promise<void> {
    try {
      console.log('[McaMemoryHooks] 💾 Saving conversation to memory...');

      await this.toolExecutor.executeTool(
        'memory_memory-save-conversation',
        {
          userMessage,
          assistantResponse,
          filesModified: metadata?.filesModified || [],
          commandsRun: metadata?.commandsRun || [],
        },
        { bypassPermissions: true },
      );

      console.log('[McaMemoryHooks] ✅ Conversation saved to memory');
    } catch (error) {
      console.warn('[McaMemoryHooks] ❌ Failed to save conversation to memory:', error);
      // Don't throw - memory saving should not break the main flow
    }
  }
}
