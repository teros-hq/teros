/**
 * Tool Commands Handler
 *
 * Handles direct tool execution from frontend (without going through agent/LLM).
 * This enables UI views (Tasks, Calendar, etc.) to interact with MCAs directly.
 *
 * Security model:
 * - User must have access to the app (owner or workspace member)
 * - Tool executes with the app's context (user or workspace)
 * - Same permission system as agent-based execution
 */

import type { WebSocket } from 'ws';
import type { McaManager } from '../../services/mca-manager';
import type { McaService } from '../../services/mca-service';
import type { WorkspaceService } from '../../services/workspace-service';
import type { CommandDeps } from './types';

/**
 * Dependencies for tool commands
 */
export interface ToolCommandsDeps extends CommandDeps {
  mcaManager: McaManager | null;
  workspaceService?: WorkspaceService;
}

/**
 * Tool execution request message
 */
interface ExecuteToolMessage {
  type: 'execute_tool';
  requestId?: string;
  appId: string;
  tool: string;
  input?: Record<string, any>;
}

/**
 * Create tool command handlers
 */
export function createToolCommands(deps: ToolCommandsDeps) {
  const { mcaService, mcaManager, workspaceService, sendMessage, sendError } = deps;

  /**
   * Check if user has access to an app
   * - User is owner of the app
   * - App belongs to a workspace where user is a member
   */
  async function userHasAppAccess(userId: string, appId: string): Promise<boolean> {
    const app = await mcaService.getApp(appId);
    if (!app) {
      return false;
    }

    // User is direct owner
    if (app.ownerId === userId) {
      return true;
    }

    // Check if app belongs to a workspace where user is a member
    if (app.ownerType === 'workspace' && workspaceService) {
      const canAccess = await workspaceService.canAccess(app.ownerId, userId);
      return canAccess;
    }

    return false;
  }

  /**
   * Get execution context for an app
   * Returns userId and workspaceId based on app ownership
   */
  async function getExecutionContext(
    userId: string,
    appId: string,
  ): Promise<{ userId: string; workspaceId?: string } | null> {
    const app = await mcaService.getApp(appId);
    if (!app) {
      return null;
    }

    if (app.ownerType === 'workspace') {
      // Workspace app: use workspaceId in context
      return {
        userId,
        workspaceId: app.ownerId,
      };
    }

    // User app: just userId
    return {
      userId: app.ownerId,
    };
  }

  return {
    /**
     * Handle execute_tool request
     *
     * Executes a tool directly without going through the agent/LLM.
     * Used by frontend UI views (Tasks, Calendar, etc.)
     */
    async handleExecuteTool(
      ws: WebSocket,
      userId: string,
      message: ExecuteToolMessage,
    ): Promise<void> {
      const { requestId, appId, tool, input = {} } = message;

      // Validate required fields
      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!tool) {
        sendError(ws, 'MISSING_TOOL', 'tool name is required');
        return;
      }

      // Check if McaManager is available
      if (!mcaManager) {
        sendError(ws, 'MCA_UNAVAILABLE', 'MCA system is not available');
        return;
      }

      try {
        // Verify user has access to the app
        const hasAccess = await userHasAppAccess(userId, appId);
        if (!hasAccess) {
          sendError(
            ws,
            'ACCESS_DENIED',
            `You don't have access to app ${appId}`,
          );
          return;
        }

        // Get execution context
        const context = await getExecutionContext(userId, appId);
        if (!context) {
          sendError(ws, 'APP_NOT_FOUND', `App ${appId} not found`);
          return;
        }

        // Get app to determine tool name prefix
        const app = await mcaService.getApp(appId);
        if (!app) {
          sendError(ws, 'APP_NOT_FOUND', `App ${appId} not found`);
          return;
        }

        // Build full tool name with app prefix
        // Tools are registered as: appName_toolName (e.g., todo_todo-list)
        const fullToolName = `${app.name}_${tool}`;

        console.log(
          `[ToolCommands] Executing tool: ${fullToolName} for user ${userId} (app: ${appId})`,
        );

        // Execute the tool
        const result = await mcaManager.executeTool(fullToolName, input, {
          appId,
          userId: context.userId,
          workspaceId: context.workspaceId,
        });

        // Parse output if it's JSON
        let output: any;
        try {
          output = JSON.parse(result.output);
        } catch {
          output = result.output;
        }

        // Send response
        sendMessage(ws, {
          type: 'tool_result',
          requestId,
          appId,
          tool,
          success: !result.isError,
          result: output,
          mcaId: result.mcaId,
        } as any);

        console.log(
          `[ToolCommands] Tool executed: ${fullToolName} (success: ${!result.isError})`,
        );
      } catch (error: any) {
        console.error(`[ToolCommands] Error executing tool ${tool}:`, error);
        sendError(ws, 'TOOL_EXECUTION_ERROR', error.message || 'Failed to execute tool');
      }
    },

    /**
     * Handle list_app_tools request
     *
     * Returns the list of available tools for an app.
     * Useful for frontend to know what tools are available.
     */
    async handleListAppTools(
      ws: WebSocket,
      userId: string,
      message: { appId: string; requestId?: string },
    ): Promise<void> {
      const { appId, requestId } = message;

      if (!appId) {
        sendError(ws, 'MISSING_APP_ID', 'appId is required');
        return;
      }

      if (!mcaManager) {
        sendError(ws, 'MCA_UNAVAILABLE', 'MCA system is not available');
        return;
      }

      try {
        // Verify user has access
        const hasAccess = await userHasAppAccess(userId, appId);
        if (!hasAccess) {
          sendError(ws, 'ACCESS_DENIED', `You don't have access to app ${appId}`);
          return;
        }

        // Get tools for the app (async method)
        const toolsResult = await mcaManager.getToolsForApp(appId);

        // Get app info for context
        const app = await mcaService.getApp(appId);

        sendMessage(ws, {
          type: 'app_tools_list',
          requestId,
          appId,
          appName: app?.name,
          status: toolsResult.status,
          error: toolsResult.error,
          tools: toolsResult.tools.map((t) => ({
            name: t.name.replace(`${app?.name}_`, ''), // Remove app prefix for cleaner API
            fullName: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
        } as any);
      } catch (error: any) {
        console.error(`[ToolCommands] Error listing tools for app ${appId}:`, error);
        sendError(ws, 'LIST_TOOLS_ERROR', error.message || 'Failed to list tools');
      }
    },
  };
}
