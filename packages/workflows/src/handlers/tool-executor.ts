/**
 * Tool Executor — Abstraction for calling MCA tools from function nodes.
 *
 * The workflows package stays decoupled from the backend's MCA infrastructure
 * by depending on this interface. The backend provides a concrete implementation
 * that delegates to AgentAppsBridge.executeTool or the MCA SDK's WebSocket client.
 *
 * Function node sandbox code accesses tools via the `tools` global object.
 * Each property on `tools` is an async function that calls `toolExecutor.call()`.
 */

// ============================================================================
// TOOL EXECUTOR INTERFACE
// ============================================================================

/**
 * Result of calling an MCA tool.
 */
export interface ToolCallResult {
  /** The tool's output (text content) */
  output: string;
  /** Whether the tool call resulted in an error */
  isError: boolean;
  /** The MCA ID that executed the tool (for logging) */
  mcaId: string;
  /** Optional attachments (files, images, etc.) */
  attachments?: Array<{ url: string; mime: string; filename?: string }>;
}

/**
 * Context passed to the tool executor for each call.
 * Identifies who is calling and from where.
 */
export interface ToolCallContext {
  userId?: string;
  workspaceId?: string;
  agentId?: string;
  channelId?: string;
}

/**
 * Tool Executor — abstracts MCA tool calls.
 *
 * The sandbox uses this to expose `tools.<tool_name>(args)` to user code.
 * Each call goes through this interface, which the backend implements to
 * route to the appropriate MCA (Gmail, Notion, Drive, etc.).
 */
export interface ToolExecutor {
  /**
   * Call an MCA tool by name.
   *
   * @param toolName - The sanitized tool name (e.g., "gmail_send-email")
   * @param args - The tool arguments as a key-value object
   * @param context - Who is calling (user, workspace, agent)
   * @returns The tool call result
   */
  call(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolCallResult>;

  /**
   * List available tool names for this workspace/user.
   * Used to populate the `tools` object in the sandbox.
   *
   * @param context - Who is calling
   * @returns Array of sanitized tool names
   */
  listTools(context: ToolCallContext): Promise<string[]>;
}

// ============================================================================
// NO-OP EXECUTOR (for tests where tool calls aren't needed)
// ============================================================================

export class NoopToolExecutor implements ToolExecutor {
  async call(
    _toolName: string,
    _args: Record<string, unknown>,
    _context: ToolCallContext,
  ): Promise<ToolCallResult> {
    return {
      output: 'No tool executor configured. Tool calls are not available.',
      isError: true,
      mcaId: 'noop',
    };
  }

  async listTools(_context: ToolCallContext): Promise<string[]> {
    return [];
  }
}
