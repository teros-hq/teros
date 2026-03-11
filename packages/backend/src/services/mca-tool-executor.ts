/**
 * MCA Tool Executor
 *
 * Adapter between McaManager and ConversationManager.
 * Ensures MCAs are spawned on-demand when tools are requested.
 *
 * One executor per agent - it knows which apps the agent has access to
 * and spawns them lazily when needed.
 *
 * IMPORTANT: Call initialize() before using. This is required because
 * ConversationManager expects getTools() to be synchronous.
 *
 * Tools are ALWAYS available via tools.json fallback, even if MCA fails to start.
 * This ensures the LLM always sees the tools the user has access to, and gets
 * descriptive errors when trying to use unavailable tools.
 */

import type { AgentAppAccess, ToolPermission } from '../types/database';
import { getToolPermission } from '../types/permissions';
import type { McaManager, McaStatus, ToolDefinition } from './mca-manager';
import type { McaService } from './mca-service';

/**
 * App status for tracking which apps are ready vs standby/error/disabled
 */
interface AppStatus {
  appId: string;
  mcaId: string;
  status: 'ready' | 'standby' | 'error' | 'disabled';
  error?: string;
}

/**
 * Result of permission check
 */
export interface PermissionCheckResult {
  allowed: boolean;
  permission: ToolPermission;
  appId?: string;
  reason?: string;
}

/**
 * Tool Executor interface (matches @teros/core IToolExecutor)
 */
export interface IToolExecutor {
  getTools(): ToolDefinition[];
  executeTool(
    toolName: string,
    input: Record<string, any>,
    options?: { toolCallId?: string; bypassPermissions?: boolean },
  ): Promise<{ output: string; isError: boolean }>;
}

/**
 * Tool Executor for MCA tools
 *
 * Used by ConversationManager to execute tool calls from LLM.
 * Spawns MCA processes on-demand.
 */
export class McaToolExecutor implements IToolExecutor {
  private initialized = false;
  private appIds: string[] = [];
  private cachedTools: ToolDefinition[] = [];
  private appStatuses: AppStatus[] = [];
  /** Maps tool name to appId for permission lookups */
  private toolToAppId: Map<string, string> = new Map();
  /** Cached access records per appId */
  private accessCache: Map<string, AgentAppAccess> = new Map();
  /** Callback for when a tool requires user confirmation */
  private onAskPermission?: (
    toolName: string,
    appId: string,
    input: Record<string, any>,
    toolCallId?: string,
  ) => Promise<boolean>;
  /** Callback for when a tool is about to execute (after permission check) */
  private onBeforeExecute?: (toolName: string, toolCallId?: string) => Promise<void>;
  /** User context for tool execution */
  private userId?: string;
  private channelId?: string;
  private workspaceId?: string;
  private userDisplayName?: string;
  private userAvatarUrl?: string;
  /** Headless mode - no user is watching. Tools with 'ask' permission are auto-denied. */
  private headless = false;

  constructor(
    private mcaManager: McaManager,
    private mcaService: McaService,
    private agentId: string,
    options?: {
      onAskPermission?: (
        toolName: string,
        appId: string,
        input: Record<string, any>,
        toolCallId?: string,
      ) => Promise<boolean>;
      onBeforeExecute?: (toolName: string, toolCallId?: string) => Promise<void>;
    },
  ) {
    this.onAskPermission = options?.onAskPermission;
    this.onBeforeExecute = options?.onBeforeExecute;
  }

  /**
   * Set the callback for asking permission
   * This allows setting the callback after construction (useful when callback depends on channelId)
   */
  setAskPermissionCallback(
    callback: (toolName: string, appId: string, input: Record<string, any>, toolCallId?: string) => Promise<boolean>,
  ): void {
    this.onAskPermission = callback;
  }

  /**
   * Clear the ask permission callback
   */
  clearAskPermissionCallback(): void {
    this.onAskPermission = undefined;
  }

  /**
   * Set the callback for before tool execution
   * Called after permission check passes, right before the tool actually executes
   * 
   * @param callback - Receives toolName and toolCallId for concurrent tool tracking
   */
  setBeforeExecuteCallback(callback: (toolName: string, toolCallId?: string) => Promise<void>): void {
    this.onBeforeExecute = callback;
  }

  /**
   * Clear the before execute callback
   */
  clearBeforeExecuteCallback(): void {
    this.onBeforeExecute = undefined;
  }

  /**
   * Set user context for tool execution
   * This context will be passed to MCAs so they know which user is executing the tool
   */
  setUserContext(
    userId: string,
    workspaceId?: string,
    userDisplayName?: string,
    userAvatarUrl?: string,
    channelId?: string,
    headless?: boolean,
  ): void {
    this.userId = userId;
    this.channelId = channelId;
    this.workspaceId = workspaceId;
    this.userDisplayName = userDisplayName;
    this.userAvatarUrl = userAvatarUrl;
    this.headless = headless ?? false;
  }

  /**
   * Clear user context
   */
  clearUserContext(): void {
    this.userId = undefined;
    this.channelId = undefined;
    this.workspaceId = undefined;
    this.userDisplayName = undefined;
    this.userAvatarUrl = undefined;
    this.headless = false;
  }

  /**
   * Initialize - ensure all apps for this agent are spawned
   * MUST be called before using getTools() or executeTool()
   *
   * Tools are always available via tools.json fallback, even if MCA fails to start.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(`[McaToolExecutor] Initializing for agent: ${this.agentId}`);

    // Get all apps this agent has access to
    const agentApps = await this.mcaService.getAgentApps(this.agentId);
    this.appIds = agentApps.apps.map(({ app }) => app.appId);

    console.log(`[McaToolExecutor] Agent ${this.agentId} has access to ${this.appIds.length} apps`);

    // Register all apps in standby mode (lazy loading - MCAs will spawn on first tool use)
    for (const appId of this.appIds) {
      await this.mcaManager.registerApp(appId);
      console.log(`[McaToolExecutor] Registered MCA in standby: ${appId}`);
    }

    // Cache tools for synchronous access (includes standby tools from tools.json)
    await this.updateToolCache();

    this.initialized = true;

    // Log summary
    const readyCount = this.appStatuses.filter((s) => s.status === 'ready').length;
    const standbyCount = this.appStatuses.filter((s) => s.status === 'standby').length;
    const errorCount = this.appStatuses.filter((s) => s.status === 'error').length;
    const disabledCount = this.appStatuses.filter((s) => s.status === 'disabled').length;

    console.log(
      `[McaToolExecutor] Initialized with ${this.cachedTools.length} tools (${readyCount} ready, ${standbyCount} standby, ${errorCount} error, ${disabledCount} disabled)`,
    );
  }

  /**
   * Update cached tools from current apps
   * Includes tools from tools.json for apps in standby mode
   * Also caches tool->appId mapping and access records for permission checks
   */
  private async updateToolCache(): Promise<void> {
    this.cachedTools = [];
    this.appStatuses = [];
    this.toolToAppId.clear();
    this.accessCache.clear();

    // Get all agent apps with access info
    const agentApps = await this.mcaService.getAgentApps(this.agentId);

    for (const appId of this.appIds) {
      const result = await this.mcaManager.getToolsForApp(appId);
      this.cachedTools.push(...result.tools);

      // Map each tool to its appId
      for (const tool of result.tools) {
        this.toolToAppId.set(tool.name, appId);
      }

      // Get app info for status tracking
      const appInfo = agentApps.apps.find((a) => a.app.appId === appId);

      // Cache access record for permission checks
      if (appInfo?.access) {
        this.accessCache.set(appId, appInfo.access);
      }

      this.appStatuses.push({
        appId,
        mcaId: appInfo?.app.mca.mcaId || 'unknown',
        status: result.status,
        error: result.error,
      });

      if (result.status === 'standby') {
        console.log(`[McaToolExecutor] App ${appId} in standby mode (will start on demand)`);
      } else if (result.status === 'error') {
        console.warn(`[McaToolExecutor] App ${appId} in error state: ${result.error}`);
      } else if (result.status === 'disabled') {
        console.log(`[McaToolExecutor] App ${appId} is disabled`);
      }
    }
  }

  /**
   * Refresh - re-check apps and spawn any new ones
   * Called when agent gets access to new apps mid-conversation
   */
  async refresh(): Promise<void> {
    console.log(`[McaToolExecutor] Refreshing apps for agent: ${this.agentId}`);

    // Get current apps
    const agentApps = await this.mcaService.getAgentApps(this.agentId);
    const currentAppIds = agentApps.apps.map(({ app }) => app.appId);

    // Find new apps
    const newAppIds = currentAppIds.filter((id) => !this.appIds.includes(id));

    // Register new apps in standby mode (lazy loading)
    for (const appId of newAppIds) {
      await this.mcaManager.registerApp(appId);
      console.log(`[McaToolExecutor] Registered new MCA in standby: ${appId}`);
      this.appIds.push(appId);
    }

    // Update cache with new tools (includes standby tools from tools.json)
    if (newAppIds.length > 0) {
      await this.updateToolCache();
      console.log(
        `[McaToolExecutor] Added ${newAppIds.length} new apps, total tools: ${this.cachedTools.length}`,
      );
    }
  }

  /**
   * Get all available tools for this agent (synchronous)
   * Called by ConversationManager to pass to LLM
   *
   * Note: initialize() must be called first
   */
  getTools(): ToolDefinition[] {
    if (!this.initialized) {
      console.warn('[McaToolExecutor] getTools called before initialization, returning empty');
      return [];
    }
    return this.cachedTools;
  }

  /**
   * Check permission for a tool
   * Returns the permission level and whether execution is allowed
   *
   * Always fetches fresh permissions from database (no caching)
   * to support real-time permission changes.
   */
  async checkToolPermission(toolName: string): Promise<PermissionCheckResult> {
    const appId = this.toolToAppId.get(toolName);
    if (!appId) {
      return {
        allowed: false,
        permission: 'forbid',
        reason: `Tool '${toolName}' not found`,
      };
    }

    // Fetch fresh permissions from database (no caching)
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      return {
        allowed: false,
        permission: 'ask',
        appId,
        reason: 'App not found, defaulting to ask',
      };
    }

    const permission = getToolPermission(app, toolName);

    return {
      allowed: permission === 'allow',
      permission,
      appId,
    };
  }

  /**
   * Get the appId for a tool
   */
  getAppIdForTool(toolName: string): string | undefined {
    return this.toolToAppId.get(toolName);
  }

  /**
   * Execute a tool call
   * Called by ConversationManager when LLM requests a tool
   *
   * Checks permissions before execution:
   * - 'allow': Execute immediately
   * - 'forbid': Return error without executing
   * - 'ask': Request user confirmation (if callback provided), otherwise deny
   */
  async executeTool(
    toolName: string,
    input: Record<string, any>,
    options?: { toolCallId?: string; bypassPermissions?: boolean },
  ): Promise<{
    output: string;
    isError: boolean;
    mcpId?: string;
    permissionDenied?: boolean;
    permissionRequired?: boolean;
  }> {
    if (!this.initialized) {
      return {
        output: `Error: Tool executor not initialized`,
        isError: true,
      };
    }

    // If bypassPermissions is true, skip permission checks (for internal/system calls)
    if (options?.bypassPermissions) {
      console.log(`[McaToolExecutor] Bypassing permissions for tool '${toolName}' (system call)`);
      
      // Find which app provides this tool
      const appId = this.toolToAppId.get(toolName);
      if (!appId) {
        return {
          output: `Error: Tool '${toolName}' not found`,
          isError: true,
        };
      }

      // Execute directly without permission checks
      try {
        return await this.mcaManager.executeTool(toolName, input, {
          agentId: this.agentId,
          channelId: this.channelId,
          appId,
          userId: this.userId,
          workspaceId: this.workspaceId,
          userDisplayName: this.userDisplayName,
          userAvatarUrl: this.userAvatarUrl,
        });
      } catch (error: any) {
        console.error(`[McaToolExecutor] Error executing tool '${toolName}':`, error);
        return {
          output: `Error executing tool: ${error.message}`,
          isError: true,
        };
      }
    }

    // Check permission before executing (fresh from database)
    const permCheck = await this.checkToolPermission(toolName);

    if (permCheck.permission === 'forbid') {
      console.log(`[McaToolExecutor] Tool '${toolName}' is forbidden for agent ${this.agentId}`);
      return {
        output: `Permission denied: Tool '${toolName}' is not allowed. This action is forbidden for this agent.`,
        isError: true,
        permissionDenied: true,
      };
    }

    if (permCheck.permission === 'ask') {
      // In headless mode (board tasks), auto-deny with a specific message
      if (this.headless) {
        console.log(`[McaToolExecutor] Tool '${toolName}' requires approval but conversation is headless — auto-denying`);
        return {
          output: `Permission denied: Tool '${toolName}' requires user approval, but this conversation is running in headless mode (no user is available to approve). The action has been automatically denied. You may add a progress note indicating that this permission is needed so it can be resolved manually.`,
          isError: true,
          permissionDenied: true,
        };
      }

      // If we have a callback for asking permission, use it
      if (this.onAskPermission) {
        console.log(`[McaToolExecutor] Requesting permission for tool '${toolName}' (toolCallId: ${options?.toolCallId})`);
        const granted = await this.onAskPermission(toolName, permCheck.appId!, input, options?.toolCallId);

        if (!granted) {
          console.log(`[McaToolExecutor] Permission denied by user for tool '${toolName}'`);
          return {
            output: `Permission denied: User declined to allow execution of '${toolName}'.`,
            isError: true,
            permissionDenied: true,
          };
        }
        console.log(`[McaToolExecutor] Permission granted by user for tool '${toolName}'`);
      } else {
        // No callback - return that permission is required
        // The caller (MessageHandler) should handle this by prompting the user
        console.log(`[McaToolExecutor] Tool '${toolName}' requires permission confirmation`);
        return {
          output: JSON.stringify({
            type: 'permission_required',
            tool: toolName,
            appId: permCheck.appId,
            input,
          }),
          isError: false,
          permissionRequired: true,
        };
      }
    }

    // Permission is 'allow' or was granted - execute the tool
    try {
      // Notify that tool is about to execute (for UI status update to 'running')
      // Only call for 'allow' permission - for 'ask', the status is already updated
      // by onPermissionGranted callback in the permission flow
      if (this.onBeforeExecute && permCheck.permission === 'allow') {
        await this.onBeforeExecute(toolName, options?.toolCallId);
      }

      // Pass appId to ensure we execute on the correct app for this agent
      // This prevents cross-user access when multiple users have apps with same name
      return await this.mcaManager.executeTool(toolName, input, {
        agentId: this.agentId,
        channelId: this.channelId,
        appId: permCheck.appId,
        userId: this.userId,
        workspaceId: this.workspaceId,
        userDisplayName: this.userDisplayName,
        userAvatarUrl: this.userAvatarUrl,
      });
    } catch (error: any) {
      // Return error with isError flag
      return {
        output: `Error executing tool '${toolName}': ${error.message}`,
        isError: true,
      };
    }
  }

  /**
   * Get mcaId for a tool name (for renderer matching)
   */
  getMcaIdForTool(toolName: string): string | undefined {
    return this.mcaManager.getMcaIdForTool(toolName);
  }

  /**
   * Check if a tool exists
   */
  hasTool(toolName: string): boolean {
    return this.cachedTools.some((t) => t.name === toolName);
  }

  /**
   * Get tool definition by name
   */
  getTool(toolName: string): ToolDefinition | undefined {
    return this.cachedTools.find((t) => t.name === toolName);
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get status of all apps for this agent
   */
  getAppStatuses(): AppStatus[] {
    return this.appStatuses;
  }

  /**
   * Get apps that are in standby mode (not running, will start on demand)
   */
  getStandbyApps(): AppStatus[] {
    return this.appStatuses.filter((s) => s.status === 'standby');
  }

  /**
   * Get apps that are in error state
   */
  getErrorApps(): AppStatus[] {
    return this.appStatuses.filter((s) => s.status === 'error');
  }

  /**
   * Get apps that are disabled
   */
  getDisabledApps(): AppStatus[] {
    return this.appStatuses.filter((s) => s.status === 'disabled');
  }
}
