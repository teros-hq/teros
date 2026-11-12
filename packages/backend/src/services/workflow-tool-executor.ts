/**
 * Workflow Tool Executor — Concrete implementation of the ToolExecutor
 * interface from @teros/workflows.
 *
 * Delegates tool calls to the backend's AgentAppsBridge (or McaManager),
 * which routes to the appropriate MCA (Gmail, Notion, Drive, etc.) via
 * the Agent Apps protocol or local process.
 *
 * This is injected into the WorkflowEngine via ActionBridgeManager so
 * that function nodes can call MCA tools from their sandboxed code.
 */

import type { ToolExecutor, ToolCallResult, ToolCallContext } from '@teros/workflows';
import type { AgentAppsBridge } from './agent-apps-bridge';

export class WorkflowToolExecutor implements ToolExecutor {
  constructor(
    private bridge: AgentAppsBridge,
  ) {}

  async call(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolCallContext,
  ): Promise<ToolCallResult> {
    const result = await this.bridge.executeTool(toolName, args, {
      userId: context.userId,
      workspaceId: context.workspaceId,
      agentId: context.agentId,
      channelId: context.channelId,
    });

    return {
      output: result.output,
      isError: result.isError,
      mcaId: result.mcaId,
      ...(result.attachments ? { attachments: result.attachments } : {}),
    };
  }

  async listTools(context: ToolCallContext): Promise<string[]> {
    // Get all apps for the workspace and collect their tool names
    // This is a best-effort listing — the backend may not have all tools
    // warmed up. The sandbox will handle "tool not found" errors gracefully.
    try {
      const status = this.bridge.getStatus();
      const toolNames: string[] = [];
      for (const app of status) {
        // Get tools for each app
        const toolsResult = await this.bridge.getToolsForApp(app.appId);
        for (const tool of toolsResult.tools) {
          toolNames.push(tool.name);
        }
      }
      return toolNames;
    } catch {
      // If we can't list tools, return empty — the sandbox will still work,
      // tools just won't be pre-populated
      return [];
    }
  }
}
