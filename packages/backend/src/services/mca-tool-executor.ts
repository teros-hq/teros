/**
 * MCA Tool Executor
 *
 * Adapter between McaManager and ConversationManager.
 * Ensures MCAs are spawned on-demand when tools are requested.
 *
 * One executor per conversation (channelId) - it knows which apps the agent
 * has access to and spawns them lazily when needed.
 *
 * IMPORTANT: Each conversation gets its own executor instance to prevent
 * cross-session race conditions where concurrent conversations of the same
 * agent overwrite each other's callbacks (onAskPermission, onBeforeExecute)
 * and streamState references.
 *
 * IMPORTANT: Call initialize() before using. This is required because
 * ConversationManager expects getTools() to be synchronous.
 *
 * Tools are ALWAYS available via tools.json fallback, even if MCA fails to start.
 * This ensures the LLM always sees the tools the user has access to, and gets
 * descriptive errors when trying to use unavailable tools.
 */

import type { AgentAppAccess, ToolPermission } from '../types/database';
import { getEffectiveToolPermission, isPrivateTool, normalizeToolName } from '../types/permissions';
import type { McaManager, McaStatus, ToolDefinition } from './mca-manager';
import type { McaService } from './mca-service';
import type { ToolExecutionService, ToolExecutionHandle } from './tool-execution-service';
import { captureException } from '../lib/sentry';
import {
  PROXY_TOOL_EXECUTE,
  PROXY_TOOL_LIST_APPS,
  PROXY_TOOL_LIST_APP_TOOLS,
  buildProxyToolDefinitions,
  isProxyTool,
} from './agent-proxy-tools';
import { buildFormToolDefinition, isFormTool } from './agent-form-tool';
import { FormSpecSchema, type FormSpec } from '@teros/shared';

/**
 * Resolution of an inline user form (request-user-input). Structural mirror of
 * FormResolution in handlers/message/pending-forms-registry.ts — kept inline
 * (like the onAskPermission signature) so services/ does not import handlers/.
 */
export type UserFormResolution =
  | { kind: 'submitted'; values: Record<string, string | number | boolean>; notes?: string }
  | { kind: 'dismissed' }
  | { kind: 'unavailable'; reason: string };

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
 * Tool Executor interface (matches @teros/core IToolExecutor).
 *
 * Minimal surface that ConversationManager + McaMemoryHooks need.
 * NOTE for downstream consumers: the concrete `McaToolExecutor` class has additional
 * members (`refresh`, `initialize`, `hasTool`, `getAppStatuses`, `clearAccessCache`, etc.)
 * that are NOT in this interface. Callers should depend on `IToolExecutor` whenever
 * possible; reach for the concrete class only when you need its lifecycle or
 * cache-management methods (typically only the cache layer in `message-handler.ts`).
 */
export interface IToolExecutor {
  getTools(): ToolDefinition[];
  executeTool(
    toolName: string,
    input: Record<string, any>,
    options?: { toolCallId?: string; bypassPermissions?: boolean; channelId?: string },
  ): Promise<{ output: string; isError: boolean; attachments?: Array<{ url: string; mime: string; filename?: string }> }>;
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
  /** App display info for the tool-execution proxy (list-installed-apps, app-ref resolution) */
  private appInfoById: Map<string, { name: string; mcaId: string; description?: string }> = new Map();
  /** Apps with toolExposure 'proxy' — their tools are omitted from getTools() but stay executable */
  private proxiedAppIds: Set<string> = new Set();
  /**
   * Tool-execution proxy gate (`tools.execution-proxy` feature flag). Resolved
   * per turn by MessageHandler.getToolExecutor and pushed here. Off (default):
   * no meta-tools are injected, `toolExposure: 'proxy'` is ignored (every app
   * exposed directly) and the meta-tool names fall through to the normal
   * "does not exist" path.
   */
  private proxyEnabled = false;
  /**
   * Inline user forms gate (`tools.user-forms` feature flag). Resolved per
   * turn by MessageHandler.getToolExecutor and pushed here. Off (default):
   * the request-user-input tool is not injected and its name falls through
   * to the normal "does not exist" path.
   */
  private formsEnabled = false;
  /** Callback that renders an inline form and blocks until the user answers
   * (request-user-input tool). Wired per channel by MessageHandler. */
  private onAskUserForm?: (
    spec: FormSpec,
    toolCallId?: string,
  ) => Promise<UserFormResolution>;
  /** Callback for when a tool requires user confirmation */
  private onAskPermission?: (
    toolName: string,
    appId: string,
    input: Record<string, any>,
    irreversible: boolean,
    toolCallId?: string,
  ) => Promise<'granted' | 'denied'>;
  /** Callback for when a tool is about to execute (after permission check) */
  private onBeforeExecute?: (toolName: string, toolCallId?: string) => Promise<void>;
  /** User context for tool execution */
  private userId?: string;
  // channelId is declared as a constructor parameter (private)
  private workspaceId?: string;
  private userDisplayName?: string;
  private userAvatarUrl?: string;
  /** Headless mode - no user is watching directly. Tools with 'ask' permission are auto-denied
   * UNLESS there is an observer chain (parent channel with a human subscriber) — in that case
   * the permission flow continues and the dual-broadcast (TER-338) surfaces the modal in
   * the parent. See TER-157 + TER-338. */
  private headless = false;
  // Survives concurrent turns on the same channel: a closure-captured
  // streamState would be reassigned by the second turn before the first
  // turn's permission lookup ran, auto-denying by missing messageId.
  private activeToolCalls = new Map<
    string,
    { messageId: string; toolName: string; toolCallId: string }
  >();
  /** Whether this channel has an observer (originChannelId !== null) reachable for permission
   * dual-broadcast. Resolved at executor construction from `channel.originChannelId`. */
  private hasObserverChannel = false;

  /**
   * Optional reference to the agent usage instrumentation tool-execution service.
   * When present together with a `sessionUsageId` in `executeTool` options, the
   * executor wraps each MCA invocation with `start()/end()` to populate the
   * `tool_executions` projection.
   */
  private toolExecutionService: ToolExecutionService | null = null;

  constructor(
    private mcaManager: McaManager,
    private mcaService: McaService,
    private agentId: string,
    private channelId: string,
    options?: {
      workspaceId?: string;
      onAskPermission?: (
        toolName: string,
        appId: string,
        input: Record<string, any>,
        irreversible: boolean,
        toolCallId?: string,
      ) => Promise<'granted' | 'denied'>;
      onBeforeExecute?: (toolName: string, toolCallId?: string) => Promise<void>;
    },
  ) {
    this.workspaceId = options?.workspaceId;
    this.onAskPermission = options?.onAskPermission;
    this.onBeforeExecute = options?.onBeforeExecute;
  }

  /**
   * Wire the (optional) tool-execution instrumentation service.
   * Called by MessageHandler.getToolExecutor when the service is available
   * in the DI container.
   */
  setToolExecutionService(service: ToolExecutionService): void {
    this.toolExecutionService = service;
  }

  /**
   * Set the callback for asking permission
   * This allows setting the callback after construction (useful when callback depends on channelId)
   */
  setAskPermissionCallback(
    callback: (
      toolName: string,
      appId: string,
      input: Record<string, any>,
      irreversible: boolean,
      toolCallId?: string,
    ) => Promise<'granted' | 'denied'>,
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
   * Enable/disable the tool-execution proxy (`tools.execution-proxy` flag).
   * Safe to call on a cached executor — takes effect on the next getTools()/
   * executeTool() call.
   */
  setProxyEnabled(enabled: boolean): void {
    this.proxyEnabled = enabled;
  }

  /**
   * Enable/disable inline user forms (`tools.user-forms` flag). Same lifecycle
   * as setProxyEnabled — safe on a cached executor, takes effect next call.
   */
  setFormsEnabled(enabled: boolean): void {
    this.formsEnabled = enabled;
  }

  /** Wire the form-rendering callback (per channel, like setAskPermissionCallback). */
  setAskUserFormCallback(
    callback: (spec: FormSpec, toolCallId?: string) => Promise<UserFormResolution>,
  ): void {
    this.onAskUserForm = callback;
  }

  clearAskUserFormCallback(): void {
    this.onAskUserForm = undefined;
  }

  trackToolCall(toolCallId: string, messageId: string, toolName: string): void {
    this.activeToolCalls.set(toolCallId, { messageId, toolName, toolCallId });
  }

  untrackToolCall(toolCallId: string): void {
    this.activeToolCalls.delete(toolCallId);
  }

  /** Returns null on unknown id; callers must treat that as auto-deny. */
  getToolCallContext(
    toolCallId?: string,
  ): { messageId: string; toolCallId: string; toolName: string } | null {
    if (!toolCallId) return null;
    const tracked = this.activeToolCalls.get(toolCallId);
    if (!tracked) return null;
    return { messageId: tracked.messageId, toolCallId, toolName: tracked.toolName };
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
    headless?: boolean,
    hasObserverChannel?: boolean,
  ): void {
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.userDisplayName = userDisplayName;
    this.userAvatarUrl = userAvatarUrl;
    this.headless = headless ?? false;
    this.hasObserverChannel = hasObserverChannel ?? false;
  }

  /**
   * Clear user context
   */
  clearUserContext(): void {
    this.userId = undefined;
    this.workspaceId = undefined;
    this.userDisplayName = undefined;
    this.userAvatarUrl = undefined;
    this.headless = false;
    this.hasObserverChannel = false;
  }

  /**
   * Initialize - ensure all apps for this agent are spawned
   * MUST be called before using getTools() or executeTool()
   *
   * Tools are always available via tools.json fallback, even if MCA fails to start.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(`[McaToolExecutor] Initializing for agent: ${this.agentId}, channel: ${this.channelId}`);

    // Get all apps this agent has access to
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId);
    this.appIds = agentApps.apps.map(({ app }) => app.appId);

    console.log(`[McaToolExecutor] Agent ${this.agentId} has access to ${this.appIds.length} apps`);

    // Register all apps in standby mode (lazy loading - MCAs will spawn on first tool use)
    // Each app is isolated: a broken tools.json must not abort the whole loop.
    for (const appId of this.appIds) {
      try {
        await this.mcaManager.registerApp(appId);
        console.log('[McaToolExecutor] Registered MCA in standby: ' + appId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[McaToolExecutor] Failed to register app ' + appId + ' - skipping:', error.message);
        captureException(error, { context: 'McaToolExecutor.initialize', appId, agentId: this.agentId });
      }
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
    this.appInfoById.clear();
    this.proxiedAppIds.clear();

    // Get all agent apps with access info (pass workspaceId to get workspace-scoped apps)
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId);

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

      // Cache display info + exposure mode for the tool-execution proxy.
      // Proxy is the DEFAULT when the proxy is enabled — every app's tools go
      // through the meta-tools unless the app is pinned `toolExposure: 'direct'`
      // (per-app opt-out). With the proxy disabled none of this applies.
      if (appInfo) {
        this.appInfoById.set(appId, {
          name: appInfo.app.name,
          mcaId: appInfo.app.mca.mcaId,
          description: appInfo.app.mca.description,
        });
        if (appInfo.app.toolExposure !== 'direct') {
          this.proxiedAppIds.add(appId);
        }
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
   * Refresh - re-check apps, register new ones, and remove revoked ones.
   * Called when agent access changes mid-conversation (grant or revoke).
   * Works in-place without recreating the executor, so active conversations
   * pick up the change immediately without a backend restart.
   */
  async refresh(): Promise<void> {
    console.log(`[McaToolExecutor] Refreshing apps for agent: ${this.agentId}`);

    // Get current apps from DB (source of truth, pass workspaceId for workspace-scoped filtering)
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId);
    const currentAppIds = agentApps.apps.map(({ app }) => app.appId);

    // Find newly granted apps
    const newAppIds = currentAppIds.filter((id) => !this.appIds.includes(id));

    // Find revoked apps
    const revokedAppIds = this.appIds.filter((id) => !currentAppIds.includes(id));

    // Register new apps in standby mode (lazy loading)
    for (const appId of newAppIds) {
      await this.mcaManager.registerApp(appId);
      console.log(`[McaToolExecutor] Registered new MCA in standby: ${appId}`);
    }

    // Remove revoked apps from the in-memory list
    for (const appId of revokedAppIds) {
      console.log(`[McaToolExecutor] Removing revoked app: ${appId}`);
    }

    // Update the app list to reflect current state
    this.appIds = currentAppIds;

    // Rebuild tool cache if anything changed
    if (newAppIds.length > 0 || revokedAppIds.length > 0) {
      await this.updateToolCache();
      console.log(
        `[McaToolExecutor] Refreshed: +${newAppIds.length} granted, -${revokedAppIds.length} revoked. Total tools: ${this.cachedTools.length}`,
      );
    } else {
      console.log(`[McaToolExecutor] No access changes detected for agent: ${this.agentId}`);
    }
  }

  /**
   * Get all available tools for this agent (synchronous)
   * Called by ConversationManager to pass to LLM
   *
   * Returns the proxy meta-tools (list-installed-apps, list-app-tools,
   * execute-tool) followed by the app tools of every DIRECT-exposure app.
   * Tools of apps with `toolExposure: 'proxy'` are omitted here — they stay in
   * `cachedTools`/`toolToAppId` so the proxy (and direct calls by remembered
   * name) resolve and gate them normally.
   *
   * Note: initialize() must be called first
   */
  getTools(): ToolDefinition[] {
    if (!this.initialized) {
      console.warn('[McaToolExecutor] getTools called before initialization, returning empty');
      return [];
    }
    // Built-in request-user-input tool (tools.user-forms flag) — injected
    // ahead of app tools, orthogonal to the proxy.
    const builtinTools = this.formsEnabled ? [buildFormToolDefinition()] : [];
    if (!this.proxyEnabled) {
      return builtinTools.length ? [...builtinTools, ...this.cachedTools] : this.cachedTools;
    }
    const directTools =
      this.proxiedAppIds.size === 0
        ? this.cachedTools
        : this.cachedTools.filter((tool) => {
            const appId = this.toolToAppId.get(tool.name);
            return !appId || !this.proxiedAppIds.has(appId);
          });
    return [
      ...builtinTools,
      ...buildProxyToolDefinitions(this.buildInstalledAppsSummary()),
      ...directTools,
    ];
  }

  /**
   * One stable line per installed app, baked into the execute-tool description
   * so the agent knows its apps without a discovery round-trip. STABLE data
   * only (name, description, tool count) — live status would bust the prompt
   * cache mid-conversation; that detail stays behind list-installed-apps.
   */
  private buildInstalledAppsSummary(): string {
    const toolCounts = this.publicToolCounts();
    const lines: string[] = [];
    const sorted = [...this.appInfoById.entries()].sort(([, a], [, b]) =>
      a.name.localeCompare(b.name),
    );
    for (const [appId, info] of sorted) {
      const description = info.description
        ? ` — ${info.description.length > 120 ? `${info.description.slice(0, 117)}...` : info.description}`
        : '';
      const direct = this.proxiedAppIds.has(appId) ? '' : ' [tools listed directly]';
      lines.push(`- ${info.name}${description} (${toolCounts.get(appId) ?? 0} tools)${direct}`);
    }
    return lines.join('\n');
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
      // executeTool() already refreshes the cache before calling us,
      // so if the tool is still missing it genuinely doesn't exist
      // (e.g. LLM hallucination). Reject instead of falling back to 'ask',
      // which would send a broken permission prompt with no appId.
      return {
        allowed: false,
        permission: 'forbid',
        reason: `Tool '${toolName}' does not exist. No app provides this tool.`,
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

    // Effective permission resolves the stored config + the read-only
    // auto-allow policy in ONE place (types/permissions.ts), so this runtime
    // gate and the permissions UI (app.get-tools) never diverge. TER-369.
    const toolDef = this.cachedTools.find((t) => t.name === toolName);
    const permission = getEffectiveToolPermission(app, toolName, toolDef?.annotations);

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
  /**
   * Run the permission gate: fresh DB check + ask flow + access-revoked recheck.
   *
   * Returns either `{ result }` (caller must abort with that response) or
   * `{ permCheck }` (caller may proceed to invoke the MCA with that appId).
   *
   * Extracted from `executeTool` to keep that method focused on transport and
   * to make the policy testable in isolation.
   */
  private async enforcePermissionPolicy(
    toolName: string,
    input: Record<string, any>,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<{
    result?: {
      output: string;
      isError: boolean;
      permissionDenied?: boolean;
      permissionRequired?: boolean;
    };
    permCheck: PermissionCheckResult;
  }> {
    // If tool is not in cache, try refreshing the tool cache once before checking permissions.
    // This handles the case where new tools were added to an MCA after initialization.
    if (!this.toolToAppId.has(toolName)) {
      console.log(`[McaToolExecutor] Tool '${toolName}' not in cache — refreshing tool cache`);
      await this.updateToolCache();
    }

    // Check permission before executing (fresh from database)
    const permCheck = await this.checkToolPermission(toolName);

    if (permCheck.permission === 'forbid') {
      console.log(`[McaToolExecutor] Tool '${toolName}' ${permCheck.appId ? 'is forbidden' : 'does not exist'} for agent ${this.agentId}`);
      const message = permCheck.appId
        ? `Permission denied: Tool '${toolName}' is not allowed. This action is forbidden for this agent.`
        : `Error: Tool '${toolName}' does not exist. No app provides this tool. Do not retry — use only the tools listed in your available tools.`;
      return {
        permCheck,
        result: {
          output: message,
          isError: true,
          permissionDenied: !!permCheck.appId,
        },
      };
    }

    if (permCheck.permission === 'ask') {
      // TER-157: headless && no observer chain = truly unattended → auto-deny.
      // Headless && observer chain = the parent channel has a human subscriber who can
      // approve via the dual-broadcast (TER-338) — fall through to onAskPermission and
      // let the observer chain surface the modal in the parent conversation.
      if (this.headless && !this.hasObserverChannel) {
        console.log(`[McaToolExecutor] Tool '${toolName}' requires approval but conversation is headless with no observer — auto-denying`);
        return {
          permCheck,
          result: {
            output: `Permission denied: Tool '${toolName}' requires user approval, but this conversation is running in headless mode with no observer channel (no user is available to approve). The action has been automatically denied. You may add a progress note indicating that this permission is needed so it can be resolved manually.`,
            isError: true,
            permissionDenied: true,
          },
        };
      }

      // If we have a callback for asking permission, use it
      if (this.onAskPermission) {
        // Look up the irreversible annotation from the cached tool definition
        // (Renderer UX Guide v2 §8).
        const toolDef = this.cachedTools.find((t) => t.name === toolName);
        const irreversible = toolDef?.annotations?.irreversible ?? false;
        console.log(`[McaToolExecutor] Requesting permission for tool '${toolName}' (toolCallId: ${options?.toolCallId}, irreversible: ${irreversible})`);
        const resolution = await this.onAskPermission(toolName, permCheck.appId!, input, irreversible, options?.toolCallId);

        if (resolution === 'denied') {
          console.log(`[McaToolExecutor] Permission denied by user for tool '${toolName}'`);
          return {
            permCheck,
            result: {
              output: `Permission denied: User declined to allow execution of '${toolName}'.`,
              isError: true,
              permissionDenied: true,
            },
          };
        }
        console.log(`[McaToolExecutor] Permission granted by user for tool '${toolName}'`);

        // The permission wait can outlive the dispatch: if the turn/step signal
        // was aborted while the user decided, the transport layer would cut the
        // call anyway. Fail fast with an actionable message instead of flipping
        // the tool to running and dying mid-flight with a generic cancellation.
        if (options?.signal?.aborted) {
          console.warn(
            `[McaToolExecutor] Permission for '${toolName}' was granted after the turn was aborted — not executing`,
          );
          return {
            permCheck,
            result: {
              output: `Tool execution was cancelled: permission was granted, but the turn was interrupted while waiting for approval. The action did not run; retry the tool if it is still needed.`,
              isError: true,
            },
          };
        }
      } else {
        // No callback - return that permission is required
        // The caller (MessageHandler) should handle this by prompting the user
        console.log(`[McaToolExecutor] Tool '${toolName}' requires permission confirmation`);
        return {
          permCheck,
          result: {
            output: JSON.stringify({
              type: 'permission_required',
              tool: toolName,
              appId: permCheck.appId,
              input,
            }),
            isError: false,
            permissionRequired: true,
          },
        };
      }
    }

    // Real-time access check: verify the agent still has access to the app right before
    // executing. This is a cheap DB read that eliminates the window where a revoked
    // permission could still be exercised because the tool cache hasn't been refreshed yet.
    if (permCheck.appId) {
      const stillHasAccess = await this.mcaService.hasAccess(this.agentId, permCheck.appId);
      if (!stillHasAccess) {
        console.warn(
          `[McaToolExecutor] Access to app ${permCheck.appId} was revoked after permission check — denying tool '${toolName}'`,
        );
        return {
          permCheck,
          result: {
            output: `Permission denied: Access to the app providing '${toolName}' has been revoked. The tool list will be updated automatically.`,
            isError: true,
            permissionDenied: true,
          },
        };
      }
    }

    return { permCheck };
  }

  /**
   * Wrap an MCA invocation with agent_usage instrumentation when a
   * `sessionUsageId` is present and the service is wired. Records:
   *   - `tool.started` (with stepIndex/toolCallIndex/inputSizeBytes).
   *   - `tool.ended` with `status` derived from the result + `outputSizeBytes`
   *     + sanitized `errorMessage` on failure.
   *
   * Fail-safe: any error thrown by the instrumentation is swallowed; the
   * caller's result/throw is preserved. The instrumentation can NEVER
   * affect the agent's correctness.
   */
  private async runInstrumented<T extends { output: string; isError: boolean }>(
    toolName: string,
    input: Record<string, any>,
    options: { sessionUsageId?: string; stepIndex?: number; toolCallIndex?: number } | undefined,
    appId: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const sessionUsageId = options?.sessionUsageId;
    const svc = this.toolExecutionService;
    let handle: ToolExecutionHandle | null = null;

    if (sessionUsageId && svc && this.userId && this.workspaceId) {
      try {
        handle = svc.start({
          sessionUsageId,
          channelId: this.channelId,
          userId: this.userId,
          agentId: this.agentId,
          workspaceId: this.workspaceId,
          stepIndex: options?.stepIndex ?? 0,
          toolCallIndex: options?.toolCallIndex ?? 0,
          toolName,
          mcaId: this.mcaManager.getMcaIdForTool(toolName),
          input,
        });
      } catch (err) {
        // Instrumentation failure must never block tool execution.
        console.warn('[McaToolExecutor] instrumentation start failed:', err);
        handle = null;
      }
    }

    try {
      const result = await run();
      if (handle && svc) {
        try {
          // Service sanitises internally — pass raw errorMessage/output.
          svc.end({
            sessionUsageId: sessionUsageId!,
            handle,
            status: result.isError ? 'error' : 'success',
            errorMessage: result.isError ? result.output : undefined,
            output: result.output,
          });
        } catch (err) {
          console.warn('[McaToolExecutor] instrumentation end (success path) failed:', err);
        }
      }
      return result;
    } catch (err: any) {
      if (handle && svc) {
        try {
          const isAbort = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
          svc.end({
            sessionUsageId: sessionUsageId!,
            handle,
            status: isAbort ? 'aborted' : 'error',
            errorMessage: err?.message ?? String(err),
          });
        } catch (instrErr) {
          console.warn('[McaToolExecutor] instrumentation end (error path) failed:', instrErr);
        }
      }
      throw err;
    }
  }

  async executeTool(
    toolName: string,
    input: Record<string, any>,
    options?: {
      toolCallId?: string;
      bypassPermissions?: boolean;
      channelId?: string;
      signal?: AbortSignal;
      /**
       * Opaque correlation id from `agent_usage_sessions`. When present
       * together with `this.toolExecutionService`, the executor wraps the
       * underlying MCA invocation with `start()/end()` to populate
       * `tool_executions` rows linked to the parent session.
       */
      sessionUsageId?: string;
      /** LLM step index (0-based) that produced this tool call. */
      stepIndex?: number;
      /** Tool index within the LLM step (0-based; today always 0 because tools run sequentially). */
      toolCallIndex?: number;
    },
  ): Promise<{
    output: string;
    isError: boolean;
    mcpId?: string;
    permissionDenied?: boolean;
    permissionRequired?: boolean;
    attachments?: Array<{ url: string; mime: string; filename?: string }>;
  }> {
    if (!this.initialized) {
      return {
        output: `Error: Tool executor not initialized`,
        isError: true,
      };
    }

    // Tool-execution proxy meta-tools.
    // Intercepted before the permission gate: the two list tools are local reads
    // (always allowed, like private tools); execute-tool re-enters this method
    // with the TARGET tool name, so the target runs through the full gate.
    // With the flag off the names fall through to the normal path and get the
    // standard "does not exist" rejection.
    // Built-in inline-form tool.
    // Intercepted before the permission gate — it IS user interaction, there
    // is nothing to protect. Flag off: falls through to "does not exist".
    if (this.formsEnabled && isFormTool(toolName)) {
      return this.executeFormRequest(input, options);
    }

    if (this.proxyEnabled && isProxyTool(toolName)) {
      if (toolName === PROXY_TOOL_EXECUTE) {
        return this.executeProxiedTool(input, options);
      }
      try {
        if (this.onBeforeExecute) {
          await this.onBeforeExecute(toolName, options?.toolCallId);
        }
        return await this.runInstrumented(toolName, input, options, undefined, async () =>
          toolName === PROXY_TOOL_LIST_APPS
            ? this.listInstalledApps()
            : this.listAppTools(input),
        );
      } catch (error: any) {
        return {
          output: `Error executing tool '${toolName}': ${error.message}`,
          isError: true,
        };
      }
    }

    // If bypassPermissions is true, skip permission checks (for internal/system calls)
    if (options?.bypassPermissions) {
      console.log(`[McaToolExecutor] Bypassing permissions for tool '${toolName}' (system call)`);
      // Still verify the agent actually has access to this app in real-time
      const appIdForTool = this.toolToAppId.get(toolName);
      if (appIdForTool) {
        const stillHasAccess = await this.mcaService.hasAccess(this.agentId, appIdForTool);
        if (!stillHasAccess) {
          console.warn(`[McaToolExecutor] Access to app ${appIdForTool} was revoked — denying bypassed tool '${toolName}'`);
          return {
            output: `Permission denied: Access to the app providing '${toolName}' has been revoked.`,
            isError: true,
          };
        }
      }
      
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
        return await this.runInstrumented(
          toolName,
          input,
          options,
          appId,
          () => this.mcaManager.executeTool(toolName, input, {
            agentId: this.agentId,
            channelId: this.channelId,
            appId,
            userId: this.userId,
            workspaceId: this.workspaceId,
            userDisplayName: this.userDisplayName,
            userAvatarUrl: this.userAvatarUrl,
            signal: options?.signal,
          }),
        );
      } catch (error: any) {
        console.error(`[McaToolExecutor] Error executing tool '${toolName}':`, error);
        return {
          output: `Error executing tool: ${error.message}`,
          isError: true,
        };
      }
    }

    // Enforce permission policy (forbid / ask / allow + access-revoked recheck).
    // Returns an early result when execution must abort, otherwise hands back the
    // permCheck so the caller can proceed to invoke the MCA.
    const policy = await this.enforcePermissionPolicy(toolName, input, options);
    if (policy.result) return policy.result;
    const permCheck = policy.permCheck;

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
      return await this.runInstrumented(
        toolName,
        input,
        options,
        permCheck.appId,
        () => this.mcaManager.executeTool(toolName, input, {
          agentId: this.agentId,
          channelId: this.channelId,
          appId: permCheck.appId,
          userId: this.userId,
          workspaceId: this.workspaceId,
          userDisplayName: this.userDisplayName,
          userAvatarUrl: this.userAvatarUrl,
          signal: options?.signal,
        }),
      );
    } catch (error: any) {
      // Return error with isError flag
      return {
        output:
          `Error executing tool '${toolName}': ${error.message}\n` +
          `If the cause is in your call (bad parameters, wrong target, missing prior step), fix it and retry this tool. ` +
          `If the app itself is unavailable (not authenticated/connected, service down, keeps failing on correct calls), ` +
          `report the failure to the user and stop — do not work around it with other tools unless the user explicitly asks for a workaround.`,
        isError: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Tool-execution proxy
  // -------------------------------------------------------------------------

  /**
   * Resolve an `app` reference from the LLM (appId or app name) to an
   * installed app. Name matching is exact first, then case-insensitive.
   */
  private resolveAppRef(ref: string): { appId: string; name: string } | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    const byId = this.appInfoById.get(trimmed);
    if (byId) return { appId: trimmed, name: byId.name };
    for (const [appId, info] of this.appInfoById) {
      if (info.name === trimmed) return { appId, name: info.name };
    }
    const lower = trimmed.toLowerCase();
    for (const [appId, info] of this.appInfoById) {
      if (info.name.toLowerCase() === lower) return { appId, name: info.name };
    }
    return null;
  }

  /** Error result helper for the proxy meta-tools. */
  private proxyError(message: string): { output: string; isError: true } {
    return { output: message, isError: true };
  }

  /** Namespaced target tool name for an `execute-tool` {app, tool} pair. */
  private proxyTargetName(appName: string, toolRef: string): string {
    const prefix = `${appName}_`;
    const trimmed = toolRef.trim();
    const shortRef = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    return `${appName}_${normalizeToolName(shortRef)}`;
  }

  /**
   * Presentation-time resolution for UI tunneling of proxied executions:
   * when `toolName` is the execute-tool meta-tool and its {app, tool} input
   * resolves to an installed app tool, returns the TARGET's namespaced tool
   * name, mcaId and inner input so the chat message renders exactly like a
   * direct call (rich renderer, real name in the permission modal).
   *
   * Returns null when not applicable (proxy disabled, not execute-tool,
   * malformed input, unknown app/tool) — the caller presents the call as-is,
   * which for a failed resolution means a visible execute-tool error block.
   * Read-only: never refreshes caches (the execution path does that).
   */
  resolveProxyExecution(
    toolName: string,
    input: Record<string, any> | undefined,
  ): { toolName: string; mcaId?: string; input: Record<string, any> } | null {
    if (!this.proxyEnabled || toolName !== PROXY_TOOL_EXECUTE) return null;
    const appRef = input?.app;
    const toolRef = input?.tool;
    if (typeof appRef !== 'string' || typeof toolRef !== 'string') return null;
    const resolved = this.resolveAppRef(appRef);
    if (!resolved) return null;
    const targetName = this.proxyTargetName(resolved.name, toolRef);
    if (this.toolToAppId.get(targetName) !== resolved.appId) return null;
    const targetInput =
      input?.input && typeof input.input === 'object' && !Array.isArray(input.input)
        ? (input.input as Record<string, any>)
        : {};
    return {
      toolName: targetName,
      mcaId: this.mcaManager.getMcaIdForTool(targetName),
      input: targetInput,
    };
  }

  private installedAppNames(): string {
    return [...this.appInfoById.values()].map((info) => info.name).join(', ');
  }

  /** Short (un-namespaced) tool name, for display and privacy filtering. */
  private shortToolName(toolName: string, appName?: string): string {
    if (appName && toolName.startsWith(`${appName}_`)) {
      return toolName.slice(appName.length + 1);
    }
    return toolName;
  }

  /** Public tool count per app (private '-' tools excluded, like the permissions UI). */
  private publicToolCounts(): Map<string, number> {
    const toolCounts = new Map<string, number>();
    for (const tool of this.cachedTools) {
      const appId = this.toolToAppId.get(tool.name);
      if (!appId) continue;
      const shortName = this.shortToolName(tool.name, this.appInfoById.get(appId)?.name);
      if (isPrivateTool(shortName)) continue;
      toolCounts.set(appId, (toolCounts.get(appId) ?? 0) + 1);
    }
    return toolCounts;
  }

  /**
   * `list-installed-apps` — apps this agent can use, with status, tool count
   * and exposure mode. Local read over the executor's own caches.
   */
  private async listInstalledApps(): Promise<{ output: string; isError: boolean }> {
    const toolCounts = this.publicToolCounts();
    const apps = this.appStatuses.map((status) => {
      const info = this.appInfoById.get(status.appId);
      return {
        app: info?.name ?? status.appId,
        appId: status.appId,
        mcaId: status.mcaId,
        ...(info?.description ? { description: info.description } : {}),
        status: status.status,
        ...(status.error ? { error: status.error } : {}),
        toolCount: toolCounts.get(status.appId) ?? 0,
        exposure: this.proxiedAppIds.has(status.appId) ? 'proxy' : 'direct',
      };
    });
    return { output: JSON.stringify({ apps }), isError: false };
  }

  /**
   * `list-app-tools` — tools of one installed app. Compact by default (name,
   * description, effective permission, annotation flags); `tools: [names]`
   * expands the selected tools with their full input schemas.
   */
  private async listAppTools(
    input: Record<string, any>,
  ): Promise<{ output: string; isError: boolean }> {
    const appRef = input?.app;
    if (typeof appRef !== 'string' || !appRef.trim()) {
      return this.proxyError(
        `Error: 'app' is required — the app name or appId from ${PROXY_TOOL_LIST_APPS}.`,
      );
    }
    const resolved = this.resolveAppRef(appRef);
    if (!resolved) {
      return this.proxyError(
        `Error: No installed app matches '${appRef}'. Installed apps: ${this.installedAppNames()}.`,
      );
    }

    // Fresh app record so the reported permissions match what would actually run.
    const app = await this.mcaService.getApp(resolved.appId);

    const requested: Set<string> | null = Array.isArray(input?.tools)
      ? new Set(input.tools.map((t: unknown) => normalizeToolName(String(t))))
      : null;

    const tools: Array<Record<string, any>> = [];
    const found = new Set<string>();
    for (const tool of this.cachedTools) {
      if (this.toolToAppId.get(tool.name) !== resolved.appId) continue;
      const shortName = this.shortToolName(tool.name, resolved.name);
      if (isPrivateTool(shortName)) continue;
      if (requested && !requested.has(shortName)) continue;
      found.add(shortName);
      tools.push({
        name: shortName,
        description: tool.description,
        permission: app ? getEffectiveToolPermission(app, tool.name, tool.annotations) : 'ask',
        ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
        ...(tool.annotations?.irreversible === true ? { irreversible: true } : {}),
        ...(tool.annotations?.alwaysAsk === true ? { alwaysAsk: true } : {}),
        ...(requested ? { inputSchema: tool.input_schema } : {}),
      });
    }

    const unknownTools = requested ? [...requested].filter((name) => !found.has(name)) : [];
    return {
      output: JSON.stringify({
        app: resolved.name,
        appId: resolved.appId,
        tools,
        ...(unknownTools.length > 0 ? { unknownTools } : {}),
      }),
      isError: false,
    };
  }

  /**
   * `request-user-input` — validate the LLM-composed form spec, render the
   * form via the channel-wired callback and block until the user answers
   *.
   *
   * Never permission-gated. On headless channels (voice, autonomous tasks)
   * no form is rendered: the agent gets a structured bypass result telling it
   * to collect the same fields conversationally. All outcomes except a
   * post-wait abort are isError:false — dismissal and unavailability are
   * guidance for the agent, not failures.
   */
  private async executeFormRequest(
    input: Record<string, any>,
    options?: Parameters<McaToolExecutor['executeTool']>[2],
  ): Promise<Awaited<ReturnType<McaToolExecutor['executeTool']>>> {
    const parsed = FormSpecSchema.safeParse(input);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'form'}: ${issue.message}`)
        .join('; ');
      return {
        output: `Error: invalid form spec — ${issues}. Fix the spec and retry.`,
        isError: true,
      };
    }
    const spec = parsed.data;

    const conversationalFallback = (reason: string) => ({
      output: JSON.stringify({
        available: false,
        reason,
        instruction:
          'Inline forms cannot be shown here. Ask the user for each field in conversation instead, one question at a time.',
        fields: spec.fields.map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          required: f.required ?? false,
        })),
      }),
      isError: false,
    });

    // Headless (voice worker, autonomous task): no interactive UI to render
    // the form in. v1 bypasses even with an observer chain — surfacing forms
    // in the parent channel is future work (spec: open decisions).
    if (this.headless) {
      return conversationalFallback('this channel has no interactive UI (headless/voice)');
    }
    if (!this.onAskUserForm) {
      return conversationalFallback('form rendering is not wired for this channel');
    }

    console.log(
      `[McaToolExecutor] Requesting user form (${spec.fields.length} fields, toolCallId: ${options?.toolCallId})`,
    );
    const resolution = await this.onAskUserForm(spec, options?.toolCallId);

    // The form wait can outlive the dispatch (same failure mode as the
    // post-grant permission abort): fail fast instead of resuming a turn
    // whose signal was already aborted.
    if (options?.signal?.aborted) {
      console.warn(
        `[McaToolExecutor] Form resolved (${resolution.kind}) after the turn was aborted — not resuming`,
      );
      return {
        output:
          resolution.kind === 'submitted'
            ? 'The user submitted the form, but the turn was interrupted while waiting. Their answers were not processed — ask again if still needed.'
            : 'Form request was cancelled: the turn was interrupted while waiting for the user.',
        isError: true,
      };
    }

    switch (resolution.kind) {
      case 'submitted':
        return {
          output: JSON.stringify({
            submitted: true,
            values: resolution.values,
            ...(resolution.notes ? { notes: resolution.notes } : {}),
          }),
          isError: false,
        };
      case 'dismissed':
        return {
          output: JSON.stringify({
            submitted: false,
            dismissed: true,
            instruction:
              'The user dismissed the form and prefers to answer in the chat. Do NOT send the form again; continue conversationally.',
          }),
          isError: false,
        };
      case 'unavailable':
        return conversationalFallback(resolution.reason);
    }
  }

  /**
   * `execute-tool` — resolve `{ app, tool }` to the namespaced tool name and
   * re-enter `executeTool` with it. The target therefore runs through the
   * exact same permission gate (fresh DB check, alwaysAsk clamp, ask flow,
   * access-revoked recheck) and instrumentation as a direct call. Recursion
   * is impossible: namespaced names always contain '_', meta-tool names never do.
   */
  private async executeProxiedTool(
    input: Record<string, any>,
    options?: Parameters<McaToolExecutor['executeTool']>[2],
  ): Promise<Awaited<ReturnType<McaToolExecutor['executeTool']>>> {
    const appRef = input?.app;
    const toolRef = input?.tool;
    if (typeof appRef !== 'string' || !appRef.trim()) {
      return this.proxyError(
        `Error: 'app' is required — the app name or appId from ${PROXY_TOOL_LIST_APPS}.`,
      );
    }
    if (typeof toolRef !== 'string' || !toolRef.trim()) {
      return this.proxyError(
        `Error: 'tool' is required — a tool name from ${PROXY_TOOL_LIST_APP_TOOLS}.`,
      );
    }
    const targetInput =
      input?.input && typeof input.input === 'object' && !Array.isArray(input.input)
        ? (input.input as Record<string, any>)
        : {};

    const resolved = this.resolveAppRef(appRef);
    if (!resolved) {
      return this.proxyError(
        `Error: No installed app matches '${appRef}'. Installed apps: ${this.installedAppNames()}.`,
      );
    }

    // Accept both the short tool name and an already-namespaced one.
    const targetName = this.proxyTargetName(resolved.name, toolRef);

    if (!this.toolToAppId.has(targetName)) {
      // Mirror enforcePermissionPolicy: refresh once in case the MCA gained tools.
      await this.updateToolCache();
    }
    const targetAppId = this.toolToAppId.get(targetName);
    if (!targetAppId) {
      return this.proxyError(
        `Error: App '${resolved.name}' has no tool '${toolRef.trim()}'. ` +
          `Call ${PROXY_TOOL_LIST_APP_TOOLS} with app '${resolved.name}' to see its tools.`,
      );
    }
    if (targetAppId !== resolved.appId) {
      // Defensive: namespaced names are keyed by app name; if two apps ever
      // collide, refuse rather than executing against the wrong app.
      return this.proxyError(
        `Error: Tool '${toolRef.trim()}' resolves to a different app than '${resolved.name}'. ` +
          `Call it directly or via its own app.`,
      );
    }

    return this.executeTool(targetName, targetInput, options);
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
