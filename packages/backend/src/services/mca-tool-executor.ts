/**
 * Unsubstituted GLM/Zhipu tool-call template placeholders that leak into
 * proxied tool-call arguments when the upstream model JSON generator fails
 * (observed on the Fireworks/teros path, glm-5p3). Detected in
 * coerceProxyInput (C3a) — see docs/specs/20260924_tag-based-tool-args-decision.md
 * for the origin analysis (upstream-owned, not fixable in this repo).
 */
const UNSUBSTITUTED_PLACEHOLDER_RE = /<arg_value|<arg_key/;
const UNSUBSTITUTED_PLACEHOLDER_SRC = "<arg_value / <arg_key";

/**
 * Whether a JSON-Schema property definition accepts `null` as a value.
 *
 * Covers the nullability forms MCAs actually declare:
 *   - `type: ["string", "null"]` (array form — todo-list plan-node `day`,
 *     where null is the documented "remove the task from its day" value)
 *   - `type: "null"`
 *   - `enum: [..., null]`
 *   - `anyOf` / `oneOf` with a branch that accepts null (checked recursively)
 *
 * Anything else — including an absent, boolean-form or type-less schema —
 * does NOT accept null. That is the conservative default: the execution
 * proxy's pre-flight keeps treating an explicit null as a missing parameter
 * unless the tool's schema explicitly declares it nullable
 * (fb_3083851078d1474c).
 */
function schemaAcceptsNull(propSchema: unknown): boolean {
  if (!propSchema || typeof propSchema !== 'object' || Array.isArray(propSchema)) return false;
  const s = propSchema as Record<string, any>;
  if (Array.isArray(s.type)) return s.type.includes('null');
  if (s.type === 'null') return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const branches = s[combinator];
    if (Array.isArray(branches) && branches.some((b) => schemaAcceptsNull(b))) return true;
  }
  return false;
}

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

import type { TerosLane } from '../models/providers/teros';
import type { AgentAppAccess, ToolPermission } from '../types/database';
import type { AppViewer } from '../types/database';
import { getEffectiveToolPermission, isPrivateTool, normalizeToolName, applyGuardVerdict } from '../types/permissions';
import type { GuardEvaluation, TerosGuardService } from './teros-guard-service';
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
import { buildFlatToolDefinitions, FlatToolRegistry, type FlatAppInfo } from './agent-proxy-flat-tools';
import { buildFormToolDefinition, isFormTool } from './agent-form-tool';
import {
  buildVoiceModeToolDefinitions,
  isVoiceModeTool,
  VOICE_GET_MODE_TOOL,
  VOICE_PAUSE_LISTENING_TOOL,
  VOICE_SET_MODE_TOOL,
  type VoiceModeToolResult,
} from './voice-mode-tools';
import { FormSpecSchema, type FormSpec, isSystemCapabilityMca } from '@teros/shared';
import { SkillService, type SkillInterpolationContext } from './skill-service';
import { escapePromptBlockAttr } from './prompt-safety';
import { createLogger } from '../lib/logger';
import { COLLECTIONS } from '../db';

const log = createLogger('McaToolExecutor');

/**
 * Resolution of an inline user form (request-user-input). Structural mirror of
 * FormResolution in handlers/message/pending-forms-registry.ts — kept inline
 * (like the onAskPermission signature) so services/ does not import handlers/.
 */
export type UserFormResolution = { kind: 'unavailable'; reason: string };

/**
 * v4 permission cut (2026-10-27): what onAskPermission returns once the ask
 * has REGISTERED the pending permission and the turn ends. The executor
 * serializes requestId — plus appId/irreversible, which completeToolMessage's
 * content rebuild would otherwise drop — into the awaiting-user marker output
 * ({ status: 'permission_requested', permissionRequestId, ... }), the same
 * mechanic as the form flow's { kind: 'displayed'; formRequestId }. That JSON
 * marker is the only durable anchor the frontend has to render the inline
 * ControlsBar (task tn_HnCvjxasWA8DD30R). 'granted'/'denied' remain the
 * defense paths that resolve before the ask is ever registered. Kept inline
 * (like UserFormResolution) so handlers/ imports services/, not vice versa.
 */
export type PermissionAskMarker = { kind: 'requested'; requestId: string };

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
 * Teros Guard (docs/specs/security/20261106_teros-guard.md) — workspace-level
 * settings (settings.terosGuard) and the conservative default watch list.
 * The global rollout switch is the feature flag `tools.teros-guard`.
 */
export interface TerosGuardSettings {
  /** Master switch for THIS workspace. Default false until rollout. */
  enabled: boolean;
  /**
   * App/MCA ids the guard watches (matched against App.mcaId, e.g.
   * `mca.teros.bash`). Empty/absent = the conservative default below.
   */
  apps?: string[];
}

/** Conservative default watch list when a workspace enables the guard without picking apps. */
const DEFAULT_GUARD_APPS = [
  'mca.teros.bash',
  'mca.teros.filesystem',
  'mca.teros.email',
  'mca.teros.gmail',
  'mca.teros.web-fetch',
  'mca.teros.replicate',
  'mca.teros.holded',
];

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
 * Voice mode tools adapter (Voice Mode v2, F2b — REQ-8). The seam between the
 * executor's built-in set_mode/get_mode/pause_listening tools and the active
 * native voice session (VoiceLoop). MessageHandler.getToolExecutor pushes a
 * session-scoped adapter per turn when a session is active for the executor's
 * (channelId, agentId); the executor keeps NO voice state of its own.
 */
export interface VoiceModeToolsAdapter {
  /** Set the session mode — returns the applied mode, or null if no session. */
  setMode(mode: 'available' | 'passive' | 'conversation'): string | null;
  /** Read the session mode — null when no session is active. */
  getMode(): string | null;
  /**
   * Pause listening for N minutes (REQ-8: passive + timed auto-return).
   * Returns the pause duration in minutes, or null if no session.
   */
  pauseListening(minutes: number): number | null;
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
   * Flat tool-call format gate (tools.flat-toolcalls feature flag).
   * When enabled, proxy apps also expose their tools as flat virtual tools
   * (e.g. remote_napoli_bash) with schemas that don't require nested JSON.
   */
  private flatToolsEnabled = false;
  private flatToolRegistry = new FlatToolRegistry();
  /**
   * Inline user forms gate (`tools.user-forms` feature flag). Resolved per
   * turn by MessageHandler.getToolExecutor and pushed here. Off (default):
   * the request-user-input tool is not injected and its name falls through
   * to the normal "does not exist" path.
   */
  private formsEnabled = false;
  /**
   * Non-blocking user interactions (`interactions.non-blocking` flag).
   * Resolved per turn by MessageHandler.getToolExecutor and pushed here.
  /**
   * Flows/Workflows gate (`flows.enabled` feature flag). Resolved per
   * turn by MessageHandler.getToolExecutor and pushed here. Off (default):
   * all tools from the `mca.teros.workflows` MCA are filtered out of
   * getTools() and blocked in executeTool() — agents cannot create, execute,
   * or manage flows even if the MCA is installed and granted.
   */
  private flowsEnabled = false;
  /**
   * Voice mode tools seam (Voice Mode v2, F2b — REQ-8). When a native voice
   * session is active for this executor's (channelId, agentId),
   * MessageHandler.getToolExecutor pushes the adapter here per turn; the
   * set_mode/get_mode/pause_listening built-ins are injected ahead of app
   * tools and intercepted before the permission gate. Null (default): no
   * voice session → the tools do not exist (a text chat has no mode axis).
   */
  private voiceTools: VoiceModeToolsAdapter | null = null;
/** Callback that renders an inline form: registers the pending form and
 * returns a `{ kind: 'displayed' }` marker — the turn ends and the answer
 * arrives later as a channel message. Wired per channel by MessageHandler. */
  private onAskUserForm?: (
    spec: FormSpec,
    toolCallId?: string,
  ) => Promise<UserFormResolution | { kind: 'displayed'; formRequestId: string }>;
  /**
   * Callback for when a tool requires user confirmation. v4 permission cut
   * (2026-10-27, Pablo direction): returns the 'permission_requested' marker
   * — the turn ends (endsTurn) and the grant/deny arrives later, waking the
   * agent in a new turn. 'granted'/'denied' remain for the auto-deny defense
   * paths (no message anchor, context lookup throw) which resolve before the
   * ask is ever registered.
   */
  private onAskPermission?: (
    toolName: string,
    appId: string,
    input: Record<string, any>,
    irreversible: boolean,
    toolCallId?: string,
    /** 🛡️ Set when the ask is guard-forced (Teros Guard force_ask) — travels to the UI payload. */
    guardReason?: string,
  ) => Promise<'granted' | 'denied' | PermissionAskMarker>;
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


  /** 🛡️ Teros Guard — optional review service over allowed calls (design Fase 1). Wired post-construction. */
  private terosGuard?: TerosGuardService;
  /** Global rollout flag for the guard (`tools.teros-guard`, cached-global-flag). Wired post-construction. */
  private terosGuardFlag?: { get(): boolean };
  /** Lane of the current turn, set by startTerosGuardTurn (TLANE-REQ-3). */
  private terosGuardLane?: TerosLane;
  /** Session store for guard context (user request + recent tool activity). Wired post-construction. */
  private sessionStore?: { getMessagesForLLM(sessionId: string): Promise<{ messages: any[] }> };
  /** Mongo handle for guard telemetry + workspace settings lookup. Wired post-construction. */
  private db?: {
    collection(name: string): {
      insertOne(doc: any): Promise<unknown>;
      findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<any>;
    };
  };

  /**
   * Channel scope — controls personal-app gating (REQ-7).
   * - 'shared': personal apps are blocked (PERSONAL_APP_BLOCKED)
   * - 'personal': personal apps are allowed
   * - undefined: treated as 'personal' (default)
   * Set via setUserContext() from the channel document.
   */
  private channelScope?: 'personal' | 'shared';
  /** MUW-REQ-12: this conversation's creator + scope — decides which granted apps exist here. */
  private viewer?: AppViewer;

  /**
   * Optional reference to the agent usage instrumentation tool-execution service.
   * When present together with a `sessionUsageId` in `executeTool` options, the
   * executor wraps each MCA invocation with `start()/end()` to populate the
   * `tool_executions` projection.
   */
  private toolExecutionService: ToolExecutionService | null = null;
  /** Optional reference to the skill service for on-demand skill loading */
  private skillService: SkillService | null = null;
  /** Optional context for skill variable interpolation */
  private skillInterpolationCtx?: SkillInterpolationContext;

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
        guardReason?: string,
      ) => Promise<'granted' | 'denied' | PermissionAskMarker>;
      onBeforeExecute?: (toolName: string, toolCallId?: string) => Promise<void>;
      skillService?: SkillService;
      skillInterpolationCtx?: SkillInterpolationContext;
    },
  ) {
    this.workspaceId = options?.workspaceId;
    this.onAskPermission = options?.onAskPermission;
    this.onBeforeExecute = options?.onBeforeExecute;
    this.skillService = options?.skillService ?? null;
    this.skillInterpolationCtx = options?.skillInterpolationCtx;
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
   * Wire the (optional) skill service + interpolation context for on-demand skill
   * loading. Safe to call on a cached, already-initialized executor: it re-registers
   * the native `load_skill` tool so an executor first built without a skill service
   * (e.g. the user-direct restored-tool path) still exposes it on a later LLM turn.
   * Called by MessageHandler.getToolExecutor when the service is available.
   */
  async setSkillContext(service: SkillService, ctx?: SkillInterpolationContext): Promise<void> {
    this.skillService = service;
    if (ctx) this.skillInterpolationCtx = ctx;
    // Before initialize() the tool cache is empty and registration runs there via
    // updateToolCache(); only re-register when the cache is already populated.
    if (this.initialized) {
      await this.registerNativeSkillTool();
    }
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
      guardReason?: string,
    ) => Promise<'granted' | 'denied' | PermissionAskMarker>,
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
   * Enable/disable flat tool-call format.
   * When enabled, proxy apps expose their tools as flat virtual tools.
   */
  setFlatToolsEnabled(enabled: boolean): void {
    this.flatToolsEnabled = enabled;
    if (!enabled) {
      this.flatToolRegistry.clear();
    }
  }

  /**
   * Enable/disable inline user forms (`tools.user-forms` flag). Same lifecycle
   * as setProxyEnabled — safe on a cached executor, takes effect next call.
   */
  setFormsEnabled(enabled: boolean): void {
    this.formsEnabled = enabled;
  }

  /**
   * Enable/disable flows/workflows tools (`flows.enabled` flag). Same lifecycle
   * as setProxyEnabled/setFormsEnabled — safe on a cached executor, takes effect
   * on the next getTools()/executeTool() call.
   */
  setFlowsEnabled(enabled: boolean): void {
    this.flowsEnabled = enabled;
  }

  /**
   * Wire (or clear) the voice mode tools adapter (Voice Mode v2, F2b, REQ-8).
   * Pushed per turn by MessageHandler.getToolExecutor when a native voice
   * session is active for this executor's channel+agent; null clears it (the
   * session ended — the tools stop existing on the next turn). Same lifecycle
   * as the flag setters: safe on a cached executor, takes effect next call.
   */
  setVoiceTools(adapter: VoiceModeToolsAdapter | null): void {
    this.voiceTools = adapter;
  }

  /** Wire the form-rendering callback (per channel, like setAskPermissionCallback). */
  setAskUserFormCallback(
    callback: (
      spec: FormSpec,
      toolCallId?: string,
    ) => Promise<UserFormResolution | { kind: 'displayed'; formRequestId: string }>,
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

  /**
   * Returns null on unknown id; callers must treat that as auto-deny.
   * `mcaId` lets the permission request carry the app's catalog id so every
   * surface can render the tool's own card (PERMW-REQ-2).
   * @spec PERMW-REQ-2
   */
  getToolCallContext(
    toolCallId?: string,
  ): { messageId: string; toolCallId: string; toolName: string; mcaId?: string } | null {
    if (!toolCallId) return null;
    const tracked = this.activeToolCalls.get(toolCallId);
    if (!tracked) return null;
    return {
      messageId: tracked.messageId,
      toolCallId,
      toolName: tracked.toolName,
      mcaId: this.mcaManager.getMcaIdForTool(tracked.toolName),
    };
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
    channelScope?: 'personal' | 'shared',
  ): void {
    this.userId = userId;
    this.workspaceId = workspaceId;
    this.userDisplayName = userDisplayName;
    this.userAvatarUrl = userAvatarUrl;
    this.headless = headless ?? false;
    this.hasObserverChannel = hasObserverChannel ?? false;
    this.channelScope = channelScope;
  }

  /**
   * 🛡️ Wire the Teros Guard (service + cached global flag + context/telemetry
   * deps). Safe to call on a cached executor — takes effect on the next
   * executeTool(). Absent/unwired = guard off (fail-open, zero change).
   */
  setTerosGuard(deps: {
    service: TerosGuardService;
    flag: { get(): boolean };
    sessionStore?: { getMessagesForLLM(sessionId: string): Promise<{ messages: any[] }> };
    db?: {
      collection(name: string): {
        insertOne(doc: any): Promise<unknown>;
        findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<any>;
      };
    };
  }): void {
    this.terosGuard = deps.service;
    this.terosGuardFlag = deps.flag;
    if (deps.sessionStore) this.sessionStore = deps.sessionStore;
    if (deps.db) this.db = deps.db;
  }

  /**
   * Start of a turn for the guard: record the turn's lane (TLANE-REQ-3: the
   * guard's request runs on it) and clear the per-turn verdict cache.
   */
  startTerosGuardTurn(lane: TerosLane): void {
    this.terosGuardLane = lane;
    this.terosGuard?.clearTurnCache();
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
    this.channelScope = undefined;
  }

  /**
   * Initialize - ensure all apps for this agent are spawned
   * MUST be called before using getTools() or executeTool()
   *
   * Tools are always available via tools.json fallback, even if MCA fails to start.
   */
  /**
   * MUW-REQ-12: the conversation decides the app set. Resolved from the channel
   * (creator + scope) and refreshed on every app-list rebuild, so a scope
   * toggle mid-conversation takes effect at the next refresh.
   */
  private async resolveViewer(): Promise<AppViewer | undefined> {
    const viewer = await this.mcaService.getChannelViewer(this.channelId);
    this.viewer = viewer ?? undefined;
    if (viewer) this.channelScope = viewer.channelScope;
    return this.viewer;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(`[McaToolExecutor] Initializing for agent: ${this.agentId}, channel: ${this.channelId}`);

    // Get all apps this agent has access to
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId, await this.resolveViewer());
    this.appIds = agentApps.apps.map(({ app }) => app.appId);

    console.log(`[McaToolExecutor] Agent ${this.agentId} has access to ${this.appIds.length} apps`);

    // Register all apps in standby mode (lazy loading - MCAs will spawn on first tool use)
    // Each app is isolated: a broken tools.json must not abort the whole loop.
    for (const appId of this.appIds) {
      try {
        await this.mcaManager.registerApp(appId);
        // Per-app registration log: fires for every app on every conversation
        // init — was a raw console.log and dominated the out log (~10k lines
        // per 100MB). Debug level keeps it greppable without the noise.
        log.debug(`Registered MCA in standby: ${appId}`);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[McaToolExecutor] Failed to register app ' + appId + ' - skipping:', error.message);
        captureException(error, { context: 'McaToolExecutor.initialize', appId, agentId: this.agentId });
      }
    }

    // Cache tools for synchronous access (includes standby tools from tools.json).
    // updateToolCache() also (re)registers the native load_skill tool.
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
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId, await this.resolveViewer());

    // Re-derive the app set from the DB instead of trusting the construction-time
    // `appIds` snapshot. updateToolCache() is the single funnel every cache rebuild
    // goes through (initialize, refresh, unknown-tool retry, proxy resolution misses),
    // so re-deriving here makes EVERY rebuild converge to the agent's current access:
    // apps installed mid-conversation appear, revoked apps disappear, and an executor
    // that missed an invalidateToolCache event (e.g. it was evicted from the executor
    // cache by TTL while a ChannelWorker still held it — incident 2026-10-31,
    // ch_a374d399653659bb) self-heals on its next rebuild.
    const currentAppIds = agentApps.apps.map(({ app }) => app.appId);
    for (const appId of currentAppIds) {
      if (!this.appIds.includes(appId)) {
        // Newly visible app (installed or granted since the last rebuild) — register
        // it in standby so getToolsForApp() below can resolve its tools. registerApp
        // is idempotent, so repeated rebuilds are harmless.
        try {
          await this.mcaManager.registerApp(appId);
          log.debug(`updateToolCache: registered newly visible app in standby: ${appId}`);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error('[McaToolExecutor] Failed to register app ' + appId + ' - skipping:', error.message);
          captureException(error, { context: 'McaToolExecutor.updateToolCache', appId, agentId: this.agentId });
        }
      }
    }
    this.appIds = currentAppIds;

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

    // Re-register the native load_skill tool: updateToolCache() rebuilds the cache
    // from apps only, so this must run on every rebuild (including refresh()) or the
    // tool would silently vanish after any mid-conversation app grant/revoke.
    await this.registerNativeSkillTool();
  }

  /**
   * (Re)register the native `load_skill` tool in the tool cache. Idempotent: drops
   * any existing entry first, then re-adds it iff the skill service is wired and the
   * agent has at least one on-demand skill. Called from updateToolCache() (so it
   * survives refresh()) and from setSkillContext() (so a cached executor picks it up).
   */
  private async registerNativeSkillTool(): Promise<void> {
    // Drop any stale entry so repeated calls are safe.
    this.cachedTools = this.cachedTools.filter((t) => t.name !== 'load_skill');
    this.toolToAppId.delete('load_skill');

    if (!this.skillService || !this.workspaceId) return;
    const onDemandIndex = await this.skillService.getOnDemandSkillIndex(this.agentId, this.workspaceId);
    if (onDemandIndex.length === 0) return;

    this.cachedTools.push({
      name: 'load_skill',
      description: 'Load a skill by name to make its full content available for this turn.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The name of the skill to load' },
        },
        required: ['name'],
      },
    });
    this.toolToAppId.set('load_skill', '__native__');
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
    const agentApps = await this.mcaService.getAgentApps(this.agentId, this.workspaceId, await this.resolveViewer());
    const currentAppIds = agentApps.apps.map(({ app }) => app.appId);

    // Find newly granted apps
    const newAppIds = currentAppIds.filter((id) => !this.appIds.includes(id));

    // Find revoked apps
    const revokedAppIds = this.appIds.filter((id) => !currentAppIds.includes(id));

    // Register new apps in standby mode (lazy loading)
    for (const appId of newAppIds) {
      await this.mcaManager.registerApp(appId);
      log.debug(`Registered new MCA in standby: ${appId}`);
    }

    // Remove revoked apps from the in-memory list
    for (const appId of revokedAppIds) {
      console.log(`[McaToolExecutor] Removing revoked app: ${appId}`);
    }

    // Update the app list to reflect current state
    this.appIds = currentAppIds;

    // Rebuild tool cache if anything changed
    if (newAppIds.length > 0 || revokedAppIds.length > 0) {
      // updateToolCache() re-registers load_skill as part of the rebuild.
      await this.updateToolCache();
      console.log(
        `[McaToolExecutor] Refreshed: +${newAppIds.length} granted, -${revokedAppIds.length} revoked. Total tools: ${this.cachedTools.length}`,
      );
    } else {
      // No app changes, but a skill's loadMode may have flipped — re-query the
      // on-demand index so load_skill availability tracks it without a full rebuild.
      await this.registerNativeSkillTool();
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
    // Built-in voice mode tools (Voice Mode v2, F2b, REQ-8) — session-scoped:
    // injected only while a native voice session is active for this
    // channel+agent (the adapter is pushed per turn by getToolExecutor).
    if (this.voiceTools) {
      builtinTools.push(...buildVoiceModeToolDefinitions());
    }

    // Flows gate (flows.enabled flag): when disabled, filter out all tools
    // from the mca.teros.workflows MCA so agents cannot create/execute/manage
    // flows even if the MCA is installed and granted.
    const tools = this.flowsEnabled
      ? this.cachedTools
      : this.cachedTools.filter((tool) => !this.isFlowsTool(tool.name));

    if (!this.proxyEnabled) {
      return builtinTools.length ? [...builtinTools, ...tools] : tools;
    }
    const directTools =
      this.proxiedAppIds.size === 0
        ? tools
        : tools.filter((tool) => {
            const appId = this.toolToAppId.get(tool.name);
            return !appId || !this.proxiedAppIds.has(appId);
          });
    // Generate flat tools for proxied apps when enabled
    let flatTools: ToolDefinition[] = [];
    if (this.flatToolsEnabled && this.proxiedAppIds.size > 0) {
      this.flatToolRegistry.clear();
      for (const appId of this.proxiedAppIds) {
        const appInfo = this.appInfoById.get(appId);
        if (!appInfo) continue;
        
        // Get tools for this app from cachedTools
        const appTools = this.cachedTools.filter(t => this.toolToAppId.get(t.name) === appId);
        if (appTools.length === 0) continue;
        
        // cachedTools stores proxied tools NAMESPACED (e.g. 'remote-raw_bash').
        // Strip the app prefix so the flat name is single-level
        // ('remote_raw_bash', not 'remote_raw_remote_raw_bash') — the LLM sees
        // one app segment + one tool segment, and the registry maps the flat
        // name back to the ORIGINAL namespaced tool for execution/presentation.
        const appPrefix = `${appInfo.name}_`;
        for (const t of appTools) {
          const shortName = t.name.startsWith(appPrefix) ? t.name.slice(appPrefix.length) : t.name;
          const [flatDef] = buildFlatToolDefinitions({
            appId,
            appName: appInfo.name,
            mcaId: appInfo.mcaId,
            tools: [{
              name: shortName,
              description: t.description || '',
              inputSchema: t.input_schema || {},
            }],
          });
          if (!flatDef) continue;
          // Registry maps flat name → ORIGINAL namespaced tool name
          this.flatToolRegistry.register(flatDef.name, appId, appInfo.name, t.name);
          flatTools.push(flatDef);
        }
      }
    }

    return [
      ...builtinTools,
      ...buildProxyToolDefinitions(this.buildInstalledAppsSummary()),
      ...directTools,
      ...flatTools,
    ];
  }

  /**
   * All executable tool names, INCLUDING proxied apps' tools that getTools()
   * hides behind the execute-tool meta-tool (tools.execution-proxy).
   *
   * Consumed by core's TurnDriver to build the maxSteps block message: in
   * proxy mode the LLM-facing toolset is just the meta-tools, so a
   * getTools()-only scan cannot tell a To Do runner (has set-output/set-state)
   * from a conversational agent — the block message fell back to "give the
   * user a status update" without naming any reporting tool (Pablo,
   * 2026-11-02). The full inventory lets the message name the tools the
   * agent can actually report with. Includes flows-gated filtering so a
   * disabled capability is not advertised as available.
   */
  getAllToolNames(): string[] {
    if (!this.initialized) return [];
    const tools = this.flowsEnabled
      ? this.cachedTools
      : this.cachedTools.filter((tool) => !this.isFlowsTool(tool.name));
    return tools.map((tool) => tool.name);
  }

  /**
   * Check whether a tool belongs to the `mca.teros.workflows` MCA.
   * Used by the flows.enabled gate to filter tools from getTools() and
   * block execution in executeTool().
   */
  private isFlowsTool(toolName: string): boolean {
    const appId = this.toolToAppId.get(toolName);
    if (!appId) return false;
    const info = this.appInfoById.get(appId);
    return info?.mcaId === 'mca.teros.workflows';
  }

  /**
   * One stable line per installed app, baked into the execute-tool description
   * so the agent knows its apps without a discovery round-trip. STABLE data
   * only (name, description, tool count) — live status would bust the prompt
   * cache mid-conversation; that detail stays behind list-installed-apps.
   *
   * System capabilities (memory, boards, tasks, … — v1.4.4) are EXCLUDED:
   * their tools are already exposed as flat tools with their own descriptions,
   * so listing them as "apps" adds noise, not signal. The summary is for the
   * agent's third-party/user apps only.
   */
  private buildInstalledAppsSummary(): string {
    const toolCounts = this.publicToolCounts();
    const lines: string[] = [];
    const sorted = [...this.appInfoById.entries()].sort(([, a], [, b]) =>
      a.name.localeCompare(b.name),
    );
    for (const [appId, info] of sorted) {
      if (isSystemCapabilityMca(info.mcaId)) continue;
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
    if (toolName === 'load_skill') {
      return { allowed: true, permission: 'allow' as ToolPermission };
    }

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
      /**
       * Awaiting-user marker (form_displayed / permission_requested — v4
       * permission cut 2026-10-27: permissions set this too, same mechanic
       * as forms). See IToolExecutor.ToolExecutionResult.endsTurn.
       */
      endsTurn?: boolean;
      /** Marker kind (PERMB-REQ-1). See IToolExecutor.ToolExecutionResult.awaiting. */
      awaiting?: 'permission' | 'form';
    };
    permCheck: PermissionCheckResult;
  }> {
    // If tool is not in cache, try refreshing the tool cache once before checking permissions.
    // This handles the case where new tools were added to an MCA after initialization.
    if (!this.toolToAppId.has(toolName)) {
      console.log(`[McaToolExecutor] Tool '${toolName}' not in cache — refreshing tool cache`);
      await this.updateToolCache();
    }

    // ──────────────────────────────────────────────────────────────────────
    // REQ-7: Personal-app gate — block personal apps in public conversations.
    //
    // This is an ADDITIONAL condition that runs BEFORE the existing Allow/Ask/Forbid
    // permission gate. It does not duplicate the permission system; it adds a
    // scope-based restriction that is orthogonal to tool-level permissions.
    //
    // Only applies to NEW tool executions — historical content is never touched.
    // undefined scope is treated as 'personal' — personal apps are allowed by default.
    // ──────────────────────────────────────────────────────────────────────
    const appIdForGate = this.toolToAppId.get(toolName);
    if (appIdForGate && appIdForGate !== '__native__') {
      const app = await this.mcaService.getApp(appIdForGate);
      const viewer = this.viewer ?? (await this.resolveViewer());
      if (app && viewer && !this.mcaService.isAppUsableBy(app, viewer)) {
        console.log(
          `[McaToolExecutor] Blocking tool '${toolName}' — app ${appIdForGate} (${app.scope}, owner ${app.installedBy}) is not usable in channel ${this.channelId} (${viewer.channelScope}, creator ${viewer.userId})`,
        );
        return {
          permCheck: {
            allowed: false,
            permission: 'forbid' as ToolPermission,
            appId: appIdForGate,
            reason: 'PERSONAL_APP_BLOCKED',
          },
          result: {
            output:
              'PERSONAL_APP_BLOCKED: this personal app cannot be used in this conversation — shared conversations only run shared apps, and a personal app only runs for the member who installed it.',
            isError: true,
            permissionDenied: true,
          },
        };
      }
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
      return this.runAskPermissionFlow(toolName, input, options, permCheck);
    }

    // 🛡️ TEROS GUARD (docs/specs/security/20261106_teros-guard.md): review layer
    // over ALLOWED calls on watched apps. Runs AFTER the resolver said 'allow'
    // and BEFORE the access-revoked recheck. It can only degrade the call
    // (force_ask → the ask flow above / block → deny) — never upgrade. Flag OFF
    // (global flag or workspace settings) or unwatched app → zero change.
    if (permCheck.permission === 'allow' && permCheck.appId) {
      const guardResult = await this.applyTerosGuard(toolName, input, permCheck);
      if (guardResult.result) return { permCheck, result: guardResult.result };
      if (guardResult.permission === 'ask') {
        // Guard forced the ask: same flow as a configured 'ask', but the
        // request payload carries guardReason so the UI can show WHY (Fase 2
        // renders it; the field is already on the wire).
        return this.runAskPermissionFlow(toolName, input, options, permCheck, guardResult.reason);
      }
      // 'allow' (pass / fail-open) → fall through to the access recheck.
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
   * The ask flow extracted verbatim from enforcePermissionPolicy so the Teros
   * Guard's force_ask verdict can enter the SAME branch (same TER-157 auto-deny,
   * same v4 cut, same dual-broadcast) instead of a parallel path. `guardReason`
   * is the guard's reason when the ask is guard-forced; undefined for normal asks.
   */
  private async runAskPermissionFlow(
    toolName: string,
    input: Record<string, any>,
    options?: { toolCallId?: string; signal?: AbortSignal },
    permCheck?: PermissionCheckResult,
    guardReason?: string,
  ): Promise<{
    result?: { output: string; isError: boolean; permissionDenied?: boolean; permissionRequired?: boolean; endsTurn?: boolean; awaiting?: 'permission' | 'form' };
    permCheck: PermissionCheckResult;
  }> {
    const check = permCheck ?? (await this.checkToolPermission(toolName));
    {
      // TER-157: headless && no observer chain = truly unattended → auto-deny.
      // Headless && observer chain = the parent channel has a human subscriber who can
      // approve via the dual-broadcast (TER-338) — fall through to onAskPermission and
      // let the observer chain surface the modal in the parent conversation.
      if (this.headless && !this.hasObserverChannel) {
        console.log(`[McaToolExecutor] Tool '${toolName}' requires approval but conversation is headless with no observer — auto-denying`);
        return {
          permCheck: check,
          result: {
            output: this.headlessDenialMessage(toolName),
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
        console.log(`[McaToolExecutor] Requesting permission for tool '${toolName}' (toolCallId: ${options?.toolCallId}, irreversible: ${irreversible}${guardReason ? ', guard-forced' : ''})`);
        const resolution = await this.onAskPermission(toolName, check.appId!, input, irreversible, options?.toolCallId, guardReason);

        if (resolution && typeof resolution === 'object' && resolution.kind === 'requested') {
          // v4 permission cut (2026-10-27, Pablo direction): the approval
          // request is registered and rendered — the turn ENDS here. This is
          // NOT a deny. On grant the backend executes the tool server-side
          // with the persisted input and wakes the agent in a new turn with
          // the result; on deny the agent wakes with the reason. The user's
          // thinking time falls BETWEEN sessions — it never counts as
          // agent-hours (the durationMs=30:00 bug).
          // endsTurn: true — the TurnDriver cuts the turn deterministically at
          // the step_end (no second LLM call hoping the model obeys the textual
          // instruction). The instruction text stays as documentation for the
          // history / replayed contexts.
          //
          // The marker output carries the permissionRequestId — plus appId and
          // irreversible — because completeToolMessage (streaming-state.ts)
          // rebuilds the tool message content on completion and DROPS those
          // fields; the JSON output is the only durable anchor the frontend
          // has to render the inline ControlsBar (task tn_HnCvjxasWA8DD30R,
          // same mechanic as the form flow's formRequestId in form_displayed).
          console.log(`[McaToolExecutor] Permission requested for tool '${toolName}' — turn ends (v4 cut)`);
          return {
            permCheck: check,
            result: {
              output: JSON.stringify({
                status: 'permission_requested',
                permissionRequestId: resolution.requestId,
                tool: toolName,
                appId: check.appId,
                irreversible,
                ...(guardReason ? { guardReason } : {}),
                instruction:
                  'The approval request is now shown to the user. End your turn now — do not wait. If the user approves, the tool will run automatically and its result will arrive in the next turn; if they deny, you will receive the reason in the next turn.',
              }),
              isError: false,
              endsTurn: true,
              // PERMB-REQ-1: a permission marker does not skip the rest of
              // the step — the TurnDriver keeps dispatching it so every ask
              // of the step is registered before the turn ends.
              awaiting: 'permission',
            },
          };
        }

        if (resolution === 'denied') {
          console.log(`[McaToolExecutor] Permission denied by user for tool '${toolName}'`);
          return {
            permCheck: check,
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
            permCheck: check,
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
          permCheck: check,
          result: {
            output: JSON.stringify({
              type: 'permission_required',
              tool: toolName,
              appId: check.appId,
              input,
            }),
            isError: false,
            permissionRequired: true,
          },
        };
      }
    }

    return { permCheck: check };
  }

  /**
   * 🛡️ Teros Guard evaluation for one allowed call on a watched app.
   *
   * Gate order (design §5): global feature flag OFF → skip; workspace settings
   * missing/disabled → skip; app not watched → skip; ZDR workspace whose S
   * size is not ZDR → skip (guard off, fail-open, recorded). Everything is
   * best-effort: ANY error here fail-opens (the allow stands) — the guard is
   * defense in depth, never the primary gate.
   *
   * Returns `{ permission: 'allow' }` to proceed, `{ permission: 'ask', reason }`
   * to force the ask flow, or `{ result }` for a direct guard deny (block).
   */
  private async applyTerosGuard(
    toolName: string,
    input: Record<string, any>,
    permCheck: PermissionCheckResult,
  ): Promise<{
    result?: { output: string; isError: boolean; permissionDenied?: boolean };
    permission: ToolPermission;
    reason?: string;
  }> {
    const skip = (why: string): { permission: ToolPermission } => {
      log.debug({ toolName, appId: permCheck.appId, why }, '[TerosGuard] skipped');
      return { permission: 'allow' };
    };
    try {
      if (!this.terosGuard) return skip('service-not-wired');
      if (!this.terosGuardFlag?.get()) return skip('global-flag-off');
      if (!this.workspaceId || !this.db) return skip('no-workspace');
      const lane = this.terosGuardLane;
      if (!lane) return skip('no-turn-lane');

      const ws = (await this.db
        .collection(COLLECTIONS.workspaces)
        .findOne({ workspaceId: this.workspaceId }, { projection: { 'settings.terosGuard': 1, 'settings.zdrOnly': 1 } })) as
        | { settings?: { terosGuard?: TerosGuardSettings; zdrOnly?: boolean } }
        | null;
      const guardSettings = ws?.settings?.terosGuard;
      if (!guardSettings?.enabled) return skip('workspace-disabled');
      const watched = guardSettings.apps?.length ? guardSettings.apps : DEFAULT_GUARD_APPS;
      const app = permCheck.appId ? await this.mcaService.getApp(permCheck.appId) : undefined;
      const appKey: string = app?.mcaId ?? permCheck.appId ?? 'unknown';
      if (!watched.includes(appKey)) return skip('app-not-watched');

      // ZDR: the guard sends tool content to the model. A zdrOnly workspace
      // must not leak to a retaining upstream — guard off (fail-open).
      if (ws?.settings?.zdrOnly && !(await this.terosGuard.isZdrCompatible(lane))) {
        return skip('zdr-incompatible');
      }

      // Context for the judgment: the original user request + recent tool
      // activity (egress = read with one call, exfiltrate with the next).
      // Context is DATA, never instructions (design §4).
      const { userRequest, recentContext } = await this.collectGuardContext();

      const evaluation = await this.terosGuard.evaluate({
        toolName,
        appId: appKey,
        input,
        userRequest,
        recentContext,
        lane,
      });

      this.recordGuardTelemetry(toolName, appKey, evaluation);

      const headlessUnattended = this.headless && !this.hasObserverChannel;
      const effective = applyGuardVerdict('allow', evaluation.verdict, headlessUnattended);
      console.log(
        `[TerosGuard] verdict=${evaluation.verdict} effective=${effective}${evaluation.failOpen ? ' (fail-open)' : ''}${evaluation.cached ? ' (cached)' : ''} latencyMs=${evaluation.latencyMs} tool=${toolName} app=${appKey}`,
      );

      if (effective === 'forbid') {
        const reason = evaluation.failOpen
          ? ''
          : `The Teros Guard blocked this call: ${evaluation.reason || 'the call does not match the user request.'}`;
        return {
          permission: 'forbid',
          reason: evaluation.reason,
          result: {
            output: `Permission denied by Teros Guard: ${reason || 'this call was judged inconsistent with the user request.'} Do not retry the same call — if you believe this is an error, explain the intent to the user and ask them to run it manually or adjust the workspace guard settings.`,
            isError: true,
            permissionDenied: true,
          },
        };
      }
      if (effective === 'ask') {
        return { permission: 'ask', reason: evaluation.reason };
      }
      return { permission: 'allow' };
    } catch (err) {
      // Fail-open: never break the product from the guard layer.
      console.error('[TerosGuard] evaluation failed — fail-open:', err);
      return { permission: 'allow' };
    }
  }

  /**
   * Guard context: the latest real user message (what the agent believes it
   * was asked) + a compact digest of the last tool calls/results of the turn.
   * Best-effort: any failure yields empty strings (the guard still judges the
   * call on its own shape).
   */
  private async collectGuardContext(): Promise<{ userRequest: string; recentContext: string }> {
    try {
      const { messages } = await this.sessionStore!.getMessagesForLLM(this.channelId);
      let userRequest = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.info.role !== 'user') continue;
        const text = msg.parts
          .filter((p: any) => p.type === 'text' && !p.synthetic)
          .map((p: any) => p.text)
          .join(' ')
          .trim();
        if (text) {
          userRequest = text;
          break;
        }
      }
      const recent: string[] = [];
      for (let i = messages.length - 1; i >= 0 && recent.length < 8; i--) {
        const msg = messages[i]!;
        if (msg.info.role !== 'assistant') continue;
        for (const part of msg.parts as any[]) {
          if (part.type !== 'tool' || !part.state?.input) continue;
          const output = typeof part.state?.output === 'string' ? part.state.output : '';
          recent.push(
            `- ${part.tool}: input=${JSON.stringify(part.state.input).slice(0, 500)} output=${output.slice(0, 500)}`,
          );
          if (recent.length >= 8) break;
        }
      }
      return { userRequest, recentContext: recent.reverse().join('\n') };
    } catch (err) {
      console.warn('[TerosGuard] context collection failed (continuing without):', err);
      return { userRequest: '', recentContext: '' };
    }
  }

  /**
   * One telemetry document per evaluation (design §7): verdict, latency,
   * fail-open and cache flags — first-class metrics for rollout and
   * calibration. Best-effort: telemetry failure never affects the call.
   */
  private recordGuardTelemetry(
    toolName: string,
    appKey: string,
    evaluation: GuardEvaluation,
  ): void {
    try {
      if (!this.db) return;
      this.db
        .collection(COLLECTIONS.terosGuardEvaluations)
        .insertOne({
          channelId: this.channelId,
          agentId: this.agentId,
          workspaceId: this.workspaceId ?? null,
          userId: this.userId ?? null,
          appId: appKey,
          toolName,
          verdict: evaluation.verdict,
          reason: evaluation.reason,
          latencyMs: evaluation.latencyMs,
          failOpen: evaluation.failOpen,
          failReason: evaluation.failReason,
          cached: evaluation.cached,
          createdAt: new Date(),
        })
        .catch((err) => console.warn('[TerosGuard] telemetry insert failed:', err));
    } catch (err) {
      console.warn('[TerosGuard] telemetry failed:', err);
    }
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
    /**
     * Awaiting-user marker (permission_requested / form_displayed): the
     * TurnDriver ends the turn deterministically at the step end.
     * See core IToolExecutor.ToolExecutionResult.endsTurn.
     */
    endsTurn?: boolean;
    /**
     * Marker kind — 'permission' keeps dispatching the step, 'form' skips
     * the rest of it. See core IToolExecutor.ToolExecutionResult.awaiting.
     * @spec PERMB-REQ-1
     */
    awaiting?: 'permission' | 'form';
  }> {
    if (!this.initialized) {
      return {
        output: `Error: Tool executor not initialized`,
        isError: true,
      };
    }

    // NATIVE TOOL: load_skill — must precede forms/proxy intercepts
    if (toolName === 'load_skill') {
      if (!this.skillService || !this.workspaceId || !this.skillInterpolationCtx) {
        return { output: 'Error: load_skill is not available in this context.', isError: true };
      }
      const rawName = (input as any)?.name;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return { output: 'Error: load_skill requires a non-empty "name" parameter.', isError: true };
      }
      const skillName = rawName.trim();
      const result = await this.skillService.loadSkillForInjection(
        this.agentId, this.workspaceId, { name: skillName }, this.skillInterpolationCtx
      );
      if (!result) {
        return { output: `Skill '${skillName}' not found, not assigned to this agent, or not enabled.`, isError: true };
      }
      return {
        output: `<loaded_skill name="${escapePromptBlockAttr(result.name)}">\n${result.content}\n</loaded_skill>`,
        isError: false,
      };
    }

    // Flows gate (flows.enabled flag): defence-in-depth. Even if a tool name
    // slips through (e.g. the LLM remembers it from a previous turn when the
    // flag was on), block execution here so flows cannot be created/executed
    // when the flag is off.
    if (!this.flowsEnabled && this.isFlowsTool(toolName)) {
      console.log(`[McaToolExecutor] Blocking flows tool '${toolName}' — flows.enabled is off`);
      return {
        output: `Tool '${toolName}' is not available. The Flows/Workflows feature is currently disabled.`,
        isError: true,
      };
    }

    // Tool-execution proxy meta-tools (docs/specs/20260704_tool-execution-proxy.md).
    // Intercepted before the permission gate: the two list tools are local reads
    // (always allowed, like private tools); execute-tool re-enters this method
    // with the TARGET tool name, so the target runs through the full gate.
    // With the flag off the names fall through to the normal path and get the
    // standard "does not exist" rejection.
    // Built-in inline-form tool (docs/specs/20260705_inline-user-forms.md).
    // Intercepted before the permission gate — it IS user interaction, there
    // is nothing to protect. Flag off: falls through to "does not exist".
    if (this.formsEnabled && isFormTool(toolName)) {
      return this.executeFormRequest(input, options);
    }

    // Built-in voice mode tools (Voice Mode v2, F2b — REQ-8). Intercepted
    // before the permission gate, like the form tool: the agent changing its
    // own listening mode is not a destructive action on any app — there is
    // nothing to protect (the mode is session state, reversible by any door).
    // With no active session the adapter is null and the names fall through
    // to the normal "does not exist" path.
    if (this.voiceTools && isVoiceModeTool(toolName)) {
      return this.executeVoiceModeTool(toolName, input);
    }

    // Flat tool-call format: intercept flat virtual tools and translate to execute-tool
    if (this.flatToolsEnabled && this.flatToolRegistry.has(toolName)) {
      const resolved = this.flatToolRegistry.resolve(toolName);
      if (!resolved) {
        return {
          output: `Error: Flat tool '${toolName}' not found in registry`,
          isError: true,
        };
      }
      // Flat-name collision guard: when the flat name equals the original
      // namespaced tool name (app 'bash' + tool 'bash' → flat 'bash_bash' ===
      // namespaced 'bash_bash'), translating to execute-tool resolves back to
      // the SAME tool name and re-enters this intercept forever → stack
      // overflow on every call (incident task_9489fb0ae1682990, 2026-10-22).
      // In that case fall through to the normal execution path below: the
      // tool is real (toolToAppId has it), so the permission gate +
      // mcaManager.executeTool run exactly once, with no flat translation.
      if (resolved.toolName !== toolName) {
        // Translate flat call to execute-tool format
        const executeToolInput = {
          app: resolved.appName,
          tool: resolved.toolName,
          input: input, // The flat input becomes the nested input
        };
        // Re-enter executeTool with execute-tool
        return this.executeTool(PROXY_TOOL_EXECUTE, executeToolInput, options);
      }
      // Collision: fall through — execute directly via the standard path.
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
  // Tool-execution proxy (docs/specs/20260704_tool-execution-proxy.md)
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

  /**
   * Resolve the target tool ref of an execute-tool call: the top-level
   * `tool` param when present, else the C1 nested `input.tool` fallback.
   * Returns null when neither exists (the caller surfaces the required error).
   * Non-mutating: the nested `tool` is stripped from the returned inner
   * input, never from the caller's original object.
   */
  private resolveProxyToolRef(
    input: Record<string, any> | undefined,
  ): { toolRef: string; innerInput: Record<string, any> | string | undefined } | null {
    const topTool = input?.tool;
    const rawInner = input?.input;
    // Nested tool is only recoverable from an object (or a parsable JSON
    // string) — the C3a placeholder form is unparseable by design.
    let nested: Record<string, any> | null = null;
    if (typeof rawInner === 'string') {
      try {
        const parsed = JSON.parse(rawInner);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          nested = parsed as Record<string, any>;
        }
      } catch {
        // Unparseable string — no nested tool to recover.
      }
    } else if (typeof rawInner === 'object' && rawInner !== null && !Array.isArray(rawInner)) {
      nested = rawInner as Record<string, any>;
    }
    const nestedTool = nested?.tool;
    if (typeof topTool === 'string' && topTool.trim()) {
      // Top-level tool present: if it is ALSO nested inside the input,
      // strip the stray copy so the target tool never sees a 'tool' param.
      if (nested && typeof nestedTool === 'string' && nestedTool.trim() && nestedTool.trim() === topTool.trim()) {
        console.warn(
          `[McaToolExecutor] execute-tool: stray 'tool' param inside input removed (matches top-level '${topTool.trim()}')`,
        );
        const { tool: _stripped, ...rest } = nested;
        return { toolRef: topTool.trim(), innerInput: rest };
      }
      return { toolRef: topTool.trim(), innerInput: rawInner };
    }
    if (typeof nestedTool === 'string' && nestedTool.trim()) {
      console.warn(
        `[McaToolExecutor] execute-tool called without top-level 'tool' — recovered '${nestedTool.trim()}' from nested input.tool (C1 fallback)`,
      );
      const { tool: _stripped, ...rest } = nested!;
      return { toolRef: nestedTool.trim(), innerInput: rest };
    }
    return null;
  }

  /** Namespaced target tool name for an `execute-tool` {app, tool} pair. */
  private proxyTargetName(appName: string, toolRef: string): string {
    const prefix = `${appName}_`;
    const trimmed = toolRef.trim();
    const shortRef = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    return `${appName}_${normalizeToolName(shortRef)}`;
  }

  /**
   * Normalise the `input` field of an `execute-tool` call.
   *
   * The LLM sometimes emits the inner input as a JSON **string** instead of
   * an object (observed in ~24% of bash calls from certain models). The old
   * code silently replaced such strings with `{}`, causing the target tool to
   * fail with a misleading "X is required" error.
   *
   * This shared normaliser is used by BOTH `executeProxiedTool` (execution
   * path) and `resolveProxyExecution` (UI tunneling path) so the behaviour
   * cannot drift.
   *
   * - object (non-array) -> returned as-is
   * - string -> JSON.parsed; if the result is a plain object, returned
   * - string that fails to parse, or any other type (array, primitive,
   *   null, undefined) -> returns an error with an actionable message that
   *   names the target tool so the model can self-correct.
   *
   * toolRef is the short tool name the model passed (e.g. bash); it is
   * included in error messages for context. input being absent entirely
   * (undefined/null) is treated as an empty object -- many tools have no
   * required parameters.
   */
  private coerceProxyInput(
    raw: unknown,
    toolRef: string,
  ): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
    // Absent input -> empty object (tools with no required params are common).
    if (raw === undefined || raw === null) {
      return { ok: true, value: {} };
    }

    // Already a plain object -> use as-is.
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return { ok: true, value: raw as Record<string, any> };
    }

    // String -> attempt JSON.parse, then validate the result is a plain object.
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '') {
        return { ok: true, value: {} };
      }

      // C3a: unsubstituted serialization placeholder. GLM/Zhipu tool-call
      // chat-template markup (<arg_value / <arg_key) leaks into the
      // arguments string when the upstream JSON generator fails (Fireworks
      // path). The real values never arrive — nothing on our side can
      // recover them — so fail with a specific, actionable error instead of
      // the generic parse error. Origin analysis:
      // docs/specs/20260924_tag-based-tool-args-decision.md
      if (UNSUBSTITUTED_PLACEHOLDER_RE.test(trimmed)) {
        return {
          ok: false,
          error:
            "Error: The 'input' for tool '" + toolRef + "' contains an unsubstituted serialization placeholder (" + UNSUBSTITUTED_PLACEHOLDER_SRC + "). " +
            'The tool-call arguments were corrupted in transit — the real values never arrived. ' +
            "Do NOT retry the same call: regenerate the complete call with 'input' as a JSON object.",
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err: any) {
        return {
          ok: false,
          error:
            `Error: The 'input' for tool '${toolRef}' was sent as a JSON string but could not be parsed. ` +
            `Parse error: ${err?.message ?? 'unknown'}. ` +
            `Send 'input' as a JSON object, not a string.`,
        };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const got = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
        return {
          ok: false,
          error:
            `Error: The 'input' for tool '${toolRef}' was a JSON string that parsed to ${got}, ` +
            `but a JSON object is required. Send 'input' as a JSON object, not a string.`,
        };
      }
      return { ok: true, value: parsed as Record<string, any> };
    }

    // Arrays, numbers, booleans, etc. -- model mistake, surface it.
    return {
      ok: false,
      error:
        `Error: The 'input' for tool '${toolRef}' has type '${typeof raw}' (value: ${JSON.stringify(raw).slice(0, 200)}), ` +
        `but a JSON object is required. Send 'input' as a JSON object.`,
    };
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
    // C1: same nested-tool fallback as executeProxiedTool, so the UI
    // tunneling path resolves the same calls the execution path accepts.
    const resolvedTool = this.resolveProxyToolRef(input);
    if (typeof appRef !== 'string' || !resolvedTool) return null;
    const toolRef = resolvedTool.toolRef;
    const resolved = this.resolveAppRef(appRef);
    if (!resolved) return null;
    const targetName = this.proxyTargetName(resolved.name, toolRef);
    if (this.toolToAppId.get(targetName) !== resolved.appId) return null;
    // Use the shared normaliser so string-typed input is coerced, not dropped.
    // On error, return null — the execution path (executeProxiedTool) will
    // surface the actionable error to the model.
    const coerced = this.coerceProxyInput(resolvedTool.innerInput, toolRef);
    if (!coerced.ok) return null;
    return {
      toolName: targetName,
      mcaId: this.mcaManager.getMcaIdForTool(targetName),
      input: coerced.value,
    };
  }

  /**
   * Presentation-time resolution for FLAT virtual tools (tools.flat-toolcalls
   * flag): when `toolName` is a registered flat tool (e.g. 'remote_raw_bash'),
   * returns the TARGET's namespaced tool name, mcaId and inner input so the
   * chat message renders exactly like a direct call (rich renderer, real name
   * in the permission modal) — same tunneling contract as resolveProxyExecution
   * for execute-tool. Returns null when not a flat tool (caller presents as-is).
   * Read-only: never refreshes caches.
   */
  resolveFlatToolExecution(
    toolName: string,
    input: Record<string, any> | undefined,
  ): { toolName: string; mcaId?: string; input: Record<string, any> } | null {
    if (!this.flatToolsEnabled) return null;
    const resolved = this.flatToolRegistry.resolve(toolName);
    if (!resolved) return null;
    const targetName = this.proxyTargetName(resolved.appName, resolved.toolName);
    if (this.toolToAppId.get(targetName) !== resolved.appId) return null;
    // Flat-name collision (flat name === namespaced original, e.g. app 'bash' +
    // tool 'bash' → both 'bash_bash'): the mapping is the identity, so there is
    // no distinct flat name to translate — present the call as-is so it executes
    // once under its real name (incident task_9489fb0ae1682990, 2026-10-22).
    if (targetName === toolName) return null;
    return {
      toolName: targetName,
      mcaId: this.mcaManager.getMcaIdForTool(targetName),
      input: input ?? {},
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
        // Always surface required params and property names so a compact
        // discovery call is enough to know what is mandatory — the model no
        // longer needs a separate `tools: [...]` fetch for the common case.
        ...(tool.input_schema?.required ? { required: tool.input_schema.required } : {}),
        ...(tool.input_schema?.properties ? { properties: Object.keys(tool.input_schema.properties) } : {}),
        // Full inputSchema only when the caller explicitly requested this tool.
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
   * (docs/specs/20260705_inline-user-forms.md).
   *
   * Never permission-gated. On headless channels (voice, autonomous tasks)
   * no form is rendered: the agent gets a structured bypass result telling it
   * to collect the same fields conversationally. All outcomes except a
   * post-wait abort are isError:false — dismissal and unavailability are
   * guidance for the agent, not failures.
   */
  /**
   * Execute a built-in voice mode tool (Voice Mode v2, F2b — REQ-8). The
   * adapter is the VoiceLoop seam (session-scoped, pushed per turn); the
   * result is a compact JSON the LLM reads. Never permission-gated — the
   * agent changing its own listening mode is session state, not a
   * destructive app action.
   */
  private async executeVoiceModeTool(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ output: string; isError: boolean }> {
    const adapter = this.voiceTools!;
    let result: VoiceModeToolResult;
    try {
      if (toolName === VOICE_SET_MODE_TOOL) {
        const mode = String(input?.mode ?? '').trim();
        if (mode !== 'conversation' && mode !== 'passive' && mode !== 'available') {
          result = { ok: false, error: `Unknown mode '${mode}'. Valid: available, passive, conversation.` };
        } else {
          const applied = adapter.setMode(mode);
          result = applied
            ? { ok: true, mode: applied }
            : { ok: false, error: 'No active voice session — the mode cannot be changed.' };
        }
      } else if (toolName === VOICE_GET_MODE_TOOL) {
        const mode = adapter.getMode();
        result = mode
          ? { ok: true, mode }
          : { ok: false, error: 'No active voice session — there is no mode to read.' };
      } else {
        // pause_listening — REQ-8: "te callaré un rato mientras terminas la
        // reunión". Implemented as passive + a timed auto-return: the loop
        // keeps transcribing (REQ-9 context) but stops responding except by
        // name, and the mode restores itself when the pause elapses.
        const rawMinutes = Number(input?.duration_minutes ?? 30);
        const minutes = Number.isFinite(rawMinutes) ? Math.min(480, Math.max(1, Math.round(rawMinutes))) : 30;
        const paused = adapter.pauseListening(minutes);
        result = paused
          ? { ok: true, mode: 'passive', pausedMinutes: minutes }
          : { ok: false, error: 'No active voice session — there is nothing to pause.' };
      }
    } catch (error: any) {
      result = { ok: false, error: `Voice mode tool failed: ${error?.message ?? String(error)}` };
    }
    return { output: JSON.stringify(result), isError: !result.ok };
  }

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

    switch (resolution.kind) {
      case 'displayed':
        // The form is rendered and the turn ENDS here. The user's answer
        // arrives later as a channel message (form_response / respondsTo)
        // and wakes the agent in a new turn.
        // endsTurn: true — the TurnDriver ends the turn at the step_end
        // without a second LLM call. awaiting: 'form' — the rest of the step
        // is synthesized as Skipped (PERMB-REQ-1 keeps that for forms).
        return {
          output: JSON.stringify({
            status: 'form_displayed',
            formRequestId: resolution.formRequestId,
            instruction:
              'The form is now displayed to the user. End your turn now — do not wait. The user\'s answers will arrive as a new message in the next turn.',
          }),
          isError: false,
          endsTurn: true,
          awaiting: 'form',
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
    if (typeof appRef !== 'string' || !appRef.trim()) {
      return this.proxyError(
        `Error: 'app' is required — the app name or appId from ${PROXY_TOOL_LIST_APPS}.`,
      );
    }
    // C1: accept the tool from the top level OR nested inside the input
    // object (the model sometimes puts it there — 35 recorded failures).
    // The resolver returns the tool ref plus the inner input with any stray
    // nested 'tool' stripped, so the target tool never sees it.
    const resolvedTool = this.resolveProxyToolRef(input);
    if (!resolvedTool) {
      return this.proxyError(
        `Error: 'tool' is required — a tool name from ${PROXY_TOOL_LIST_APP_TOOLS}.`,
      );
    }
    const toolRef = resolvedTool.toolRef;
    // Use the shared normaliser so string-typed input is coerced, not dropped.
    // On error, surface an actionable message naming the target tool so the
    // model can self-correct on the next step.
    const coerced = this.coerceProxyInput(resolvedTool.innerInput, toolRef);
    if (!coerced.ok) {
      return this.proxyError(coerced.error);
    }
    const targetInput = coerced.value;

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

    // Pre-flight validation: check required params BEFORE dispatching to the
    // MCA. This turns an opaque leaf error (e.g. "description is required")
    // into a precise, actionable message and avoids a wasted round-trip.
    const targetToolDef = this.cachedTools.find((t) => t.name === targetName);
    const requiredParams = targetToolDef?.input_schema?.required as string[] | undefined;
    if (requiredParams && requiredParams.length > 0) {
      const targetProps = targetToolDef?.input_schema?.properties;
      const missing = requiredParams.filter((p) => {
        const value = targetInput[p];
        // An explicit null is a PRESENT value when the tool's schema declares
        // the parameter nullable (e.g. todo-list plan-node `day: null` — the
        // documented "remove from its day" call). Only an undeclared null
        // (schema not nullable / property unknown) counts as missing
        // (fb_3083851078d1474c).
        if (value === null) {
          const propSchema = targetProps?.[p];
          return !schemaAcceptsNull(propSchema);
        }
        return value === undefined || value === '';
      });
      if (missing.length > 0) {
        const missingList = missing.map((p) => `'${p}'`).join(', ');
        return this.proxyError(
          `Error: Tool '${toolRef.trim()}' is missing required parameter${missing.length > 1 ? 's' : ''}: ${missingList}. ` +
            `Call ${PROXY_TOOL_LIST_APP_TOOLS} with app '${resolved.name}' and tools: ['${toolRef.trim()}'] to see the full schema.`,
        );
      }
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
   * Whether the agent currently has an app installed for the given mcaId
   * (v1.4.4 system capabilities). Presence = the capability is ON: the app
   * resolved through getAgentApps (grants + workspace scoping). Used to gate
   * implicit platform behaviour on the capability actually being there —
   * e.g. memory hooks must not run (and must not write to Qdrant) when the
   * memory capability is toggled OFF for the agent.
   */
  hasMca(mcaId: string): boolean {
    return [...this.appInfoById.values()].some((info) => info.mcaId === mcaId);
  }

  /**
   * Result text of a tool call auto-denied because the conversation is headless
   * with no observer channel. When the agent has the To Do app, it is told to
   * block the task with the permission it needs instead of sending it to review.
   * @spec TODOAP-REQ-23
   */
  headlessDenialMessage(toolName: string): string {
    const prefix = `Permission denied: Tool '${toolName}' requires user approval, but this conversation is running in headless mode with no observer channel (no user is available to approve). The action has been automatically denied.`;
    if (this.hasTool('todo-list_set-state')) {
      return `${prefix} Set the task to \`blocked\` with \`todo-list_set-state\` and the reason "Permission needed: ${toolName} — <what you needed it for>". Do not send the task to review.`;
    }
    return `${prefix} You may add a progress note indicating that this permission is needed so it can be resolved manually.`;
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
