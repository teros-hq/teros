/**
 * MCP Tool Executor
 *
 * Wrapper around MCPToolManager that provides a simple interface
 * for ConversationManager to use.
 *
 * This class is what ConversationManager will call when tools need to be executed.
 */

import type { ToolDefinition } from '../llm/ILLMClient';
import type { IToolExecutor, ToolExecutionOptions } from './IToolExecutor';
import type { MCPToolManager } from './MCPToolManager';

/**
 * Tool Executor for MCP tools
 *
 * Used by ConversationManager to execute tool calls from LLM
 */
export class MCPToolExecutor implements IToolExecutor {
  constructor(public toolManager: MCPToolManager) {}

  /**
   * Get all available tools
   * Called by ConversationManager to pass to LLM
   */
  getTools(): ToolDefinition[] {
    return this.toolManager.getTools();
  }

  /**
   * Execute a tool call
   * Called by ConversationManager when LLM requests a tool
   */
  async executeTool(
    toolName: string,
    input: Record<string, any>,
    _options?: ToolExecutionOptions,
  ): Promise<{ output: string; isError: boolean }> {
    try {
      return await this.toolManager.executeTool(toolName, input);
    } catch (error: any) {
      // Return error with isError flag
      return {
        output: `Error executing tool '${toolName}': ${error.message}`,
        isError: true,
      };
    }
  }

  /**
   * Check if a tool exists
   */
  hasTool(toolName: string): boolean {
    const tools = this.toolManager.getTools();
    return tools.some((t) => t.name === toolName);
  }

  /**
   * Get tool definition by name
   */
  getTool(toolName: string): ToolDefinition | undefined {
    const tools = this.toolManager.getTools();
    return tools.find((t) => t.name === toolName);
  }
}
