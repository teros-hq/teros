/**
 * Tool Executor Interface
 *
 * Defines the contract for tool executors that can be used by ConversationManager.
 * Implementations include MCPToolExecutor (core) and McaToolExecutor (backend).
 */

import type { ToolDefinition } from '../llm/ILLMClient';

/**
 * Result from executing a tool
 */
export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  /** MCP ID for renderer matching (optional for backward compatibility) */
  mcaId?: string;
}

/**
 * Options for tool execution
 */
export interface ToolExecutionOptions {
  /** The unique ID of this tool call (for tracking concurrent executions) */
  toolCallId?: string;
}

/**
 * Interface for tool executors
 *
 * ConversationManager uses this interface to:
 * 1. Get available tools to pass to LLM
 * 2. Execute tools when LLM requests them
 */
export interface IToolExecutor {
  /**
   * Get all available tools
   * Called by ConversationManager to pass to LLM
   */
  getTools(): ToolDefinition[];

  /**
   * Execute a tool call
   * Called by ConversationManager when LLM requests a tool
   *
   * @param toolName - Name of the tool to execute
   * @param input - Input parameters for the tool
   * @param options - Optional execution options (toolCallId for concurrent tool support)
   * @returns Tool output, error status, and optionally mcaId for renderer matching
   */
  executeTool(
    toolName: string,
    input: Record<string, any>,
    options?: ToolExecutionOptions,
  ): Promise<ToolExecutionResult>;

  /**
   * Get mcaId for a tool name (optional, for renderer matching)
   */
  getMcpIdForTool?(toolName: string): string | undefined;
}
